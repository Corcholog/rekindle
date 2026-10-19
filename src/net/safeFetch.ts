import * as dns from 'dns';
import * as net from 'net';
import { Agent } from 'undici';

export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

const blockList = new net.BlockList();
const BLOCKED_IPV4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const BLOCKED_IPV6: [string, number][] = [
  ['::', 96],          // unspecified, loopback and deprecated IPv4-compatible
  ['64:ff9b::', 96],   // NAT64 (embeds IPv4)
  ['100::', 64],       // discard
  ['2001:db8::', 32],  // documentation
  ['fc00::', 7],       // unique local
  ['fe80::', 10],      // link-local
  ['ff00::', 8],       // multicast
];
for (const [prefix, bits] of BLOCKED_IPV4) blockList.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of BLOCKED_IPV6) blockList.addSubnet(prefix, bits, 'ipv6');

export class SsrfBlockedError extends Error {
  code = 'ESSRFBLOCKED';
  constructor(target: string) {
    super(`Acceso denegado (SSRF): no se permite acceder a direcciones locales o privadas (${target}).`);
  }
}

function expandIPv6(ip: string): number[] {
  let addr = ip.split('%')[0];
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number);
    addr = `${addr.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = addr.split('::');
  const headGroups = head ? head.split(':') : [];
  const restGroups = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const missing = 8 - headGroups.length - restGroups.length;
  const groups = rest === undefined
    ? headGroups
    : [...headGroups, ...Array(missing).fill('0'), ...restGroups];
  return groups.map(g => parseInt(g, 16));
}

/** True for any address Loom must never fetch from (private, loopback, link-local, reserved). */
export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return blockList.check(ip, 'ipv4');
  if (version !== 6) return true;

  const groups = expandIPv6(ip);
  const isMappedV4 = groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff;
  if (isMappedV4) {
    const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    return blockList.check(v4, 'ipv4');
  }
  return blockList.check(ip, 'ipv6');
}

type AddressPolicy = (ip: string) => boolean;
const defaultPolicy: AddressPolicy = ip => !isBlockedAddress(ip);

// Validating inside the connect-time lookup means the IP that is checked is the IP that is
// dialed, so DNS rebinding between a check and the request is not possible.
function guardedLookup(isAllowed: AddressPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      const blocked = list.find(a => !isAllowed(a.address));
      if (list.length === 0 || blocked) {
        return callback(new SsrfBlockedError(`${hostname} -> ${blocked?.address ?? 'sin dirección'}`));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function assertFetchableUrl(url: URL, isAllowed: AddressPolicy): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Protocol '${url.protocol}' is not allowed; only http and https are supported.`);
  }
  // Node skips DNS lookup for IP literals, so they are checked here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isAllowed(host)) {
    throw new SsrfBlockedError(host);
  }
}

function findSsrfError(err: unknown): SsrfBlockedError | null {
  let current: any = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof SsrfBlockedError || current.code === 'ESSRFBLOCKED') return current;
    current = current.cause;
  }
  return null;
}

async function readLimitedText(response: any, maxBytes: number): Promise<string> {
  const limitMb = Math.round(maxBytes / (1024 * 1024));
  const declared = response.headers?.get?.('content-length');
  if (declared && parseInt(declared, 10) > maxBytes) {
    throw new Error(`Content size exceeds ${limitMb}MB limit (${declared} bytes)`);
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Downloaded content exceeds ${limitMb}MB limit`);
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  }

  // Test doubles without a body stream
  if (typeof response.text === 'function') {
    const text: string = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`Downloaded content exceeds ${limitMb}MB limit`);
    }
    return text;
  }
  throw new Error('Unsupported response body format');
}

export interface FetchedPage {
  text: string;
  finalUrl: string;
}

export interface FetchPublicPageOptions {
  isAddressAllowed?: AddressPolicy;
  maxBytes?: number;
}

/**
 * Fetches an HTML or text page from the public internet only. Every redirect hop and every
 * resolved address is checked; the body is streamed with a hard size cap.
 */
export async function fetchPublicPage(rawUrl: string, options: FetchPublicPageOptions = {}): Promise<FetchedPage> {
  const isAllowed = options.isAddressAllowed ?? defaultPolicy;
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  const agent = new Agent({ connect: { lookup: guardedLookup(isAllowed) as any } });

  try {
    let current = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertFetchableUrl(current, isAllowed);

      let response: any;
      try {
        response = await fetch(current.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LoomBot/1.0)',
            'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          },
          dispatcher: agent,
        } as RequestInit);
      } catch (err) {
        throw findSsrfError(err) ?? err;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers?.get?.('location');
        await response.body?.cancel?.();
        if (!location) throw new Error(`Failed to fetch URL: ${response.status} redirect without Location`);
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers?.get?.('content-type') || 'text/html';
      if (!ALLOWED_CONTENT_TYPES.some(t => contentType.includes(t))) {
        throw new Error(`Unsupported content type "${contentType}". Only HTML or text web pages are supported.`);
      }

      const text = await readLimitedText(response, maxBytes);
      return { text, finalUrl: current.toString() };
    }
    throw new Error(`Failed to fetch URL: more than ${MAX_REDIRECTS} redirects`);
  } finally {
    await agent.close().catch(() => {});
  }
}
