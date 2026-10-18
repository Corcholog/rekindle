import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { z } from 'zod';

// Free-tier APIs answer HTTP 429. In production that should fall through to the next provider;
// in an eval it must wait and retry the SAME provider, so a baseline is never silently answered
// by a different model. A spent daily quota stops the run instead of burning retries.
const schema = z.object({ ok: z.boolean() });

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: (...args: unknown[]) => geminiCall(...args) };
  },
}));
let geminiCall: (...args: unknown[]) => Promise<unknown> = async () => ({ text: '{"ok":true}' });

describe('rate limit classification', () => {
  it('Gemini 429 becomes a rate_limit error with the suggested delay', async () => {
    const { GeminiProvider } = await import('../src/ai/providers/gemini');
    const provider = new GeminiProvider({ apiKey: 'k' });

    geminiCall = async () => {
      throw Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"23s"}]}}'), { status: 429 });
    };
    const err: any = await provider.complete('s', 'u', schema).catch(e => e);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(23_000);
    expect(err.quotaExhausted).toBeFalsy();

    geminiCall = async () => {
      throw Object.assign(new Error('Quota exceeded for metric generate_content_free_tier_requests, limit PerDay'), { status: 429 });
    };
    const daily: any = await provider.complete('s', 'u', schema).catch(e => e);
    expect(daily.kind).toBe('rate_limit');
    expect(daily.quotaExhausted).toBe(true);
  });

  it('Gemini 503 "high demand" becomes unavailable, a transient server-side condition', async () => {
    const { GeminiProvider } = await import('../src/ai/providers/gemini');
    geminiCall = async () => {
      throw Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}'), { status: 503 });
    };
    const err: any = await new GeminiProvider({ apiKey: 'k' }).complete('s', 'u', schema).catch(e => e);
    expect(err.kind).toBe('unavailable');
  });

  describe('DeepSeek', () => {
    let server: http.Server;
    let baseUrl: string;
    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(429, { 'Retry-After': '7', 'Content-Type': 'application/json' });
        res.end('{}');
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

    it('HTTP 5xx is unavailable', async () => {
      const unavailable = http.createServer((_req, res) => { res.writeHead(503); res.end('{}'); });
      await new Promise<void>(resolve => unavailable.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(unavailable.address() as AddressInfo).port}`;
      const { DeepSeekProvider } = await import('../src/ai/providers/deepseek');
      const err: any = await new DeepSeekProvider({ apiKey: 'k', baseUrl: url }).complete('s', 'u', schema).catch(e => e);
      await new Promise(resolve => unavailable.close(resolve));
      expect(err.kind).toBe('unavailable');
    });

    it('HTTP 429 honors Retry-After', async () => {
      const { DeepSeekProvider } = await import('../src/ai/providers/deepseek');
      const err: any = await new DeepSeekProvider({ apiKey: 'k', baseUrl }).complete('s', 'u', schema).catch(e => e);
      expect(err.kind).toBe('rate_limit');
      expect(err.retryAfterMs).toBe(7_000);
    });
  });
});

describe('chain policy for rate limits', () => {
  const limited = (name: string, outcomes: ('rate_limit' | 'quota' | object)[]) => {
    const calls: number[] = [];
    return {
      name, model: `${name}-model`, calls,
      async complete() {
        calls.push(1);
        const next = outcomes.shift();
        const { ProviderError } = await import('../src/ai/types');
        if (next === 'rate_limit') throw new ProviderError('rate_limit', 'limit', { retryAfterMs: 1000 });
        if (next === 'quota') throw new ProviderError('rate_limit', 'daily', { quotaExhausted: true });
        return { data: next, usage: { promptTokens: 1, completionTokens: 1 } };
      },
    };
  };
  const fallbackOk = () => ({ name: 'ollama', model: 'q', async complete() { return { data: { ok: true } }; } });
  let sleeps: number[];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  beforeEach(() => { sleeps = []; });

  it('production default: a rate limit moves straight to the next provider', async () => {
    const { runChain } = await import('../src/ai/chain');
    const gemini = limited('gemini', ['rate_limit']);
    const result = await runChain([gemini, fallbackOk()] as any[], 's', 'u', schema);
    expect(result.model).toBe('ollama:q');
    expect(gemini.calls).toHaveLength(1);
  });

  it('wait mode: sleeps the suggested delay and retries the same provider', async () => {
    const { runChain } = await import('../src/ai/chain');
    const gemini = limited('gemini', ['rate_limit', 'rate_limit', { ok: true }]);
    const result = await runChain([gemini, fallbackOk()] as any[], 's', 'u', schema, undefined, {
      onRateLimit: 'wait', maxRetries: 5, baseDelayMs: 500, maxDelayMs: 60_000, sleep,
    });
    expect(result.model).toBe('gemini:gemini-model');
    expect(sleeps).toEqual([1000, 1000]);
    expect(result.attempts.filter(a => a.errorKind === 'rate_limit')).toHaveLength(2);
    expect(result.attempts.reduce((s, a) => s + (a.waitedMs ?? 0), 0)).toBe(2000);
  });

  it('wait mode: gives up after the retry budget WITHOUT falling back', async () => {
    const { runChain, ChainError } = await import('../src/ai/chain');
    const gemini = limited('gemini', Array(10).fill('rate_limit'));
    const fallback = fallbackOk();
    const err: any = await runChain([gemini, fallback] as any[], 's', 'u', schema, undefined, {
      onRateLimit: 'wait', maxRetries: 2, baseDelayMs: 500, maxDelayMs: 60_000, sleep,
    }).catch(e => e);

    expect(err).toBeInstanceOf(ChainError);
    expect(err.rateLimited).toBe(true);
    expect(gemini.calls).toHaveLength(3); // first try + 2 retries
    expect(err.attempts.every((a: any) => a.provider === 'gemini')).toBe(true);
  });

  it('wait mode: also retries the same provider when it is temporarily unavailable', async () => {
    const { runChain } = await import('../src/ai/chain');
    const { ProviderError } = await import('../src/ai/types');
    let n = 0;
    const provider = { name: 'gemini', model: 'm', async complete() { if (n++ < 2) throw new ProviderError('unavailable', '503'); return { data: { ok: true } }; } };
    const result = await runChain([provider, fallbackOk()] as any[], 's', 'u', schema, undefined, {
      onRateLimit: 'wait', maxRetries: 5, baseDelayMs: 100, maxDelayMs: 1000, sleep,
    });
    expect(result.model).toBe('gemini:m');
    expect(sleeps).toEqual([100, 200]);
    expect(result.attempts.filter(a => a.errorKind === 'unavailable')).toHaveLength(2);
  });

  it('production default: an unavailable provider moves to the next one', async () => {
    const { runChain } = await import('../src/ai/chain');
    const { ProviderError } = await import('../src/ai/types');
    const down = { name: 'gemini', model: 'm', async complete() { throw new ProviderError('unavailable', '503'); } };
    expect((await runChain([down, fallbackOk()] as any[], 's', 'u', schema)).model).toBe('ollama:q');
  });

  it('wait mode: uses exponential backoff when the provider gives no delay', async () => {
    const { runChain } = await import('../src/ai/chain');
    const { ProviderError } = await import('../src/ai/types');
    let n = 0;
    const provider = { name: 'gemini', model: 'm', async complete() { if (n++ < 3) throw new ProviderError('rate_limit', 'x'); return { data: { ok: true } }; } };
    await runChain([provider] as any[], 's', 'u', schema, undefined, { onRateLimit: 'wait', maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 3500, sleep });
    expect(sleeps).toEqual([1000, 2000, 3500]); // 1s, 2s, then capped
  });

  it('wait mode: an exhausted daily quota stops immediately and is flagged', async () => {
    const { runChain } = await import('../src/ai/chain');
    const gemini = limited('gemini', ['quota']);
    const err: any = await runChain([gemini, fallbackOk()] as any[], 's', 'u', schema, undefined, {
      onRateLimit: 'wait', maxRetries: 5, baseDelayMs: 500, maxDelayMs: 60_000, sleep,
    }).catch(e => e);
    expect(err.quotaExhausted).toBe(true);
    expect(sleeps).toEqual([]);
    expect(gemini.calls).toHaveLength(1);
  });
});
