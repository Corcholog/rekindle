import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Audit F-01 / F-11: the local API must reject DNS-rebinding hosts and cross-site writes.
describe('Request guard (Host / Origin)', () => {
  let server: any;

  beforeAll(async () => {
    server = (await import('../src/api/server')).server;
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('rejects a DNS-rebinding Host header on reads and writes', async () => {
    const read = await server.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example:3000' } });
    expect(read.statusCode).toBe(403);

    const write = await server.inject({
      method: 'PATCH',
      url: '/api/suggestions/00000000-0000-0000-0000-000000000000',
      headers: { host: 'evil.example:3000' },
      payload: { status: 'accepted' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('accepts loopback Host headers', async () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000']) {
      const res = await server.inject({ method: 'GET', url: '/health', headers: { host } });
      expect(res.statusCode).toBe(200);
    }
  });

  it('rejects state-changing requests from foreign origins, including other local ports', async () => {
    for (const origin of ['https://evil.example', 'http://localhost:5173', 'null']) {
      const res = await server.inject({
        method: 'PATCH',
        url: '/api/suggestions/00000000-0000-0000-0000-000000000000',
        headers: { origin },
        payload: { status: 'accepted' },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('only lets the browser extension origin reach /api/ingest', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/suggestions/00000000-0000-0000-0000-000000000000',
      headers: { origin: 'chrome-extension://abcdefghijklmnop' },
      payload: { status: 'accepted' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('isRequestAllowed policy', () => {
  it('applies Host and Origin rules', async () => {
    const { isRequestAllowed } = await import('../src/api/requestGuard');
    const port = 3000;
    const base = { method: 'POST', url: '/api/ingest', host: '127.0.0.1:3000' };

    expect(isRequestAllowed({ ...base }, port)).toBe(true); // no Origin: non-browser client
    expect(isRequestAllowed({ ...base, origin: 'http://127.0.0.1:3000' }, port)).toBe(true);
    expect(isRequestAllowed({ ...base, origin: 'http://localhost:3000' }, port)).toBe(true);
    expect(isRequestAllowed({ ...base, origin: 'chrome-extension://abc' }, port)).toBe(true);
    expect(isRequestAllowed({ ...base, url: '/api/ingest?x=1', origin: 'chrome-extension://abc' }, port)).toBe(true);
    expect(isRequestAllowed({ ...base, url: '/api/settings/vault', origin: 'chrome-extension://abc' }, port)).toBe(false);
    expect(isRequestAllowed({ ...base, origin: 'http://127.0.0.1:4000' }, port)).toBe(false);
    expect(isRequestAllowed({ ...base, host: undefined }, port)).toBe(false);
    expect(isRequestAllowed({ ...base, host: '127.0.0.1.nip.io:3000' }, port)).toBe(false);
    // Cross-origin GETs are harmless: the browser blocks reading the response (no CORS headers)
    expect(isRequestAllowed({ method: 'GET', url: '/api/projects', host: 'localhost:3000', origin: 'https://evil.example' }, port)).toBe(true);
  });

  it('refuses a non-loopback HOST binding', async () => {
    const { parseEnv } = await import('../src/config');
    expect(() => parseEnv({ HOST: '0.0.0.0' })).toThrow();
    expect(() => parseEnv({ HOST: '192.168.1.10' })).toThrow();
    expect(parseEnv({ HOST: '127.0.0.1' }).HOST).toBe('127.0.0.1');
    expect(parseEnv({}).HOST).toBe('127.0.0.1');
  });
});
