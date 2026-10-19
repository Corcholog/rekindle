import { FastifyInstance } from 'fastify';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Only the Manifest V3 clipper may call Rekindle from a non-UI origin, and only to ingest.
const EXTENSION_ROUTES = new Set(['/api/ingest']);

export interface GuardedRequest {
  method: string;
  url: string;
  host?: string;
  origin?: string;
}

function hostnameOf(hostHeader: string): string {
  // "[::1]:3000" -> "[::1]", "localhost:3000" -> "localhost"
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  return hostHeader.split(':')[0];
}

function isUiOrigin(origin: string, port: number): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && LOOPBACK_HOSTNAMES.has(parsed.hostname)
      && Number(parsed.port || 80) === port;
  } catch {
    return false;
  }
}

/**
 * Host check blocks DNS rebinding (a page whose domain re-resolves to 127.0.0.1).
 * Origin check blocks cross-site writes; cross-origin reads are already blocked by the
 * browser because Rekindle sends no CORS headers.
 */
export function isRequestAllowed(req: GuardedRequest, port: number): boolean {
  if (!req.host || !LOOPBACK_HOSTNAMES.has(hostnameOf(req.host.toLowerCase()))) {
    return false;
  }

  if (!STATE_CHANGING_METHODS.has(req.method.toUpperCase()) || req.origin === undefined) {
    return true;
  }

  if (isUiOrigin(req.origin, port)) return true;

  const path = req.url.split('?')[0];
  return req.origin.startsWith('chrome-extension://') && EXTENSION_ROUTES.has(path);
}

export function registerRequestGuard(server: FastifyInstance, port: number): void {
  server.addHook('onRequest', async (request, reply) => {
    const allowed = isRequestAllowed({
      method: request.method,
      url: request.url,
      host: request.headers.host,
      origin: request.headers.origin,
    }, port);

    if (!allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Solicitud rechazada: origen o host no permitido.',
      });
    }
  });
}
