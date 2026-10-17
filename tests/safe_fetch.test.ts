import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';

// Audit F-05: SSRF protection must hold after DNS resolution and across redirects,
// and the body size cap must be enforced while streaming.
describe('isBlockedAddress', () => {
  it('blocks private, loopback, link-local, CGNAT, multicast and mapped addresses', async () => {
    const { isBlockedAddress } = await import('../src/net/safeFetch');
    const blocked = [
      '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1',
    ];
    const allowed = ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'];

    for (const ip of blocked) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of allowed) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('rejects private IPv6 literals at the API boundary', async () => {
    const { isPrivateOrLoopbackHost } = await import('../src/workers/ingestionWorker');
    expect(isPrivateOrLoopbackHost('[::ffff:127.0.0.1]')).toBe(true);
    expect(isPrivateOrLoopbackHost('[fd00::1]')).toBe(true);
    expect(isPrivateOrLoopbackHost('example.com')).toBe(false);
  });
});

describe('safeFetch against local servers', () => {
  let publicServer: http.Server;
  let privateServer: http.Server;
  let publicPort: number;
  let privatePort: number;

  // Loopback stands in for both networks: 127.0.0.1 plays "public", 127.0.0.2 plays "private".
  const policy = (ip: string) => ip === '127.0.0.1';

  beforeAll(async () => {
    privateServer = http.createServer((_req, res) => res.end('internal secret'));
    await new Promise<void>(resolve => privateServer.listen(0, '127.0.0.2', resolve));
    privatePort = (privateServer.address() as AddressInfo).port;

    publicServer = http.createServer((req, res) => {
      if (req.url === '/redirect-private') {
        res.writeHead(302, { Location: `http://127.0.0.2:${privatePort}/` });
        return res.end();
      }
      if (req.url === '/redirect-ok') {
        res.writeHead(301, { Location: '/article' });
        return res.end();
      }
      if (req.url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const chunk = Buffer.alloc(1024 * 1024, 'a');
        for (let i = 0; i < 6; i++) res.write(chunk);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>ok article</p></body></html>');
    });
    await new Promise<void>(resolve => publicServer.listen(0, '127.0.0.1', resolve));
    publicPort = (publicServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise(resolve => publicServer.close(resolve));
    await new Promise(resolve => privateServer.close(resolve));
  });

  it('follows a redirect to an allowed address', async () => {
    const { fetchPublicPage } = await import('../src/net/safeFetch');
    const page = await fetchPublicPage(`http://127.0.0.1:${publicPort}/redirect-ok`, { isAddressAllowed: policy });
    expect(page.text).toContain('ok article');
    expect(page.finalUrl).toBe(`http://127.0.0.1:${publicPort}/article`);
  });

  it('rejects a redirect hop that lands on a blocked address', async () => {
    const { fetchPublicPage } = await import('../src/net/safeFetch');
    await expect(
      fetchPublicPage(`http://127.0.0.1:${publicPort}/redirect-private`, { isAddressAllowed: policy }),
    ).rejects.toThrow(/SSRF/);
  });

  it('rejects hostnames that resolve to a blocked address', async () => {
    const { fetchPublicPage } = await import('../src/net/safeFetch');
    // "localhost" resolves to loopback; the default policy must refuse it after DNS resolution.
    await expect(fetchPublicPage(`http://localhost:${publicPort}/article`)).rejects.toThrow(/SSRF/);
  });

  it('aborts bodies larger than the cap while streaming', async () => {
    const { fetchPublicPage } = await import('../src/net/safeFetch');
    await expect(
      fetchPublicPage(`http://127.0.0.1:${publicPort}/huge`, { isAddressAllowed: policy }),
    ).rejects.toThrow(/exceeds 5MB/);
  });

  it('rejects non-http schemes', async () => {
    const { fetchPublicPage } = await import('../src/net/safeFetch');
    await expect(fetchPublicPage('file:///etc/passwd')).rejects.toThrow(/Protocolo/);
  });
});
