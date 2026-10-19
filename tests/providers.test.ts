import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { z } from 'zod';

// Provider chain: DeepSeek -> Gemini -> Ollama. DeepSeek is exercised against a local HTTP
// server that mimics its OpenAI-compatible API; the others are fakes.
const schema = z.object({ verdict: z.enum(['actionable', 'irrelevant']), score: z.number() });

describe('DeepSeekProvider', () => {
  let server: http.Server;
  let baseUrl: string;
  let requests: { headers: http.IncomingHttpHeaders; body: any }[];
  let replies: { status?: number; body: any }[];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        requests.push({ headers: req.headers, body: JSON.parse(raw) });
        const reply = replies.shift() ?? { status: 500, body: {} };
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { requests = []; replies = []; });

  const completion = (content: string | null, usage: Record<string, unknown> = { prompt_tokens: 120, completion_tokens: 30 }) => ({
    status: 200,
    body: { choices: [{ message: { content } }], usage },
  });
  const make = async () => {
    const { DeepSeekProvider } = await import('../src/ai/providers/deepseek');
    return new DeepSeekProvider({ apiKey: 'test-key', baseUrl, model: 'deepseek-flash' });
  };

  it('sends JSON mode with thinking disabled and parses data and usage', async () => {
    replies.push(completion('{"verdict":"actionable","score":0.9}'));
    const result = await (await make()).complete('Eres un evaluador.', 'texto', schema);

    expect(result.data).toEqual({ verdict: 'actionable', score: 0.9 });
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 30 });

    const { body, headers } = requests[0];
    expect(headers.authorization).toBe('Bearer test-key');
    expect(body.model).toBe('deepseek-flash');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toMatch(/json/i);
    expect(body.messages[0].content).toContain('verdict');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'texto' });
    expect(body.temperature).toBeDefined();
  });

  it('enables thinking on request and then omits temperature', async () => {
    replies.push(completion('{"verdict":"irrelevant","score":0.1}'));
    await (await make()).complete('s', 'u', schema, { thinking: true });
    expect(requests[0].body.thinking).toEqual({ type: 'enabled' });
    expect(requests[0].body.temperature).toBeUndefined();
  });

  it('reports cache hits and thinking tokens as parts of the totals', async () => {
    replies.push(completion('{"verdict":"irrelevant","score":0.1}', {
      prompt_tokens: 2000, completion_tokens: 700, prompt_cache_hit_tokens: 1500, prompt_cache_miss_tokens: 500,
      completion_tokens_details: { reasoning_tokens: 600 },
    }));
    const result = await (await make()).complete('s', 'u', schema, { thinking: true });
    expect(result.usage).toEqual({ promptTokens: 2000, completionTokens: 700, cachedPromptTokens: 1500, reasoningTokens: 600 });
  });

  it('classifies failures', async () => {
    const provider = await make();
    const kind = async () => provider.complete('s', 'u', schema).then(() => 'ok', (e: any) => e.kind);

    replies.push(completion(''));
    expect(await kind()).toBe('empty');
    replies.push(completion('esto no es json'));
    expect(await kind()).toBe('invalid_json');
    replies.push(completion('{"verdict":"maybe","score":1}'));
    expect(await kind()).toBe('schema');
    replies.push({ status: 503, body: { error: 'high demand' } });
    expect(await kind()).toBe('unavailable');
    replies.push({ status: 401, body: { error: 'bad key' } });
    expect(await kind()).toBe('http');
  });

  it('accepts JSON wrapped in a code fence', async () => {
    replies.push(completion('```json\n{"verdict":"irrelevant","score":0}\n```'));
    const result = await (await make()).complete('s', 'u', schema);
    expect(result.data.verdict).toBe('irrelevant');
  });
});

describe('provider chain', () => {
  const fake = (name: string, outcomes: (object | string)[]) => {
    const calls: number[] = [];
    return {
      name, model: `${name}-model`, calls,
      async complete() {
        calls.push(1);
        const next = outcomes.shift();
        if (typeof next === 'string') {
          const { ProviderError } = await import('../src/ai/types');
          throw new ProviderError(next as any, `${name} ${next}`);
        }
        return { data: next, usage: { promptTokens: 10, completionTokens: 5 } };
      },
    };
  };
  const good = { verdict: 'actionable', score: 0.8 };

  it('retries once on malformed output from the same provider', async () => {
    const { runChain } = await import('../src/ai/chain');
    const a = fake('deepseek', ['empty', good]);
    const result = await runChain([a as any], 's', 'u', schema);

    expect(result.data).toEqual(good);
    expect(result.model).toBe('deepseek:deepseek-model');
    expect(a.calls).toHaveLength(2);
    expect(result.attempts.map(x => [x.ok, x.errorKind])).toEqual([[false, 'empty'], [true, undefined]]);
  });

  it('falls back to the next provider after a failed retry or an HTTP error', async () => {
    const { runChain } = await import('../src/ai/chain');
    const a = fake('deepseek', ['schema', 'schema']);
    const b = fake('gemini', ['http']);
    const c = fake('ollama', [good]);
    const result = await runChain([a, b, c] as any[], 's', 'u', schema);

    expect(result.model).toBe('ollama:ollama-model');
    expect(a.calls).toHaveLength(2); // malformed output: one retry
    expect(b.calls).toHaveLength(1); // transport error: no retry
    expect(result.attempts.map(x => x.provider)).toEqual(['deepseek', 'deepseek', 'gemini', 'ollama']);
  });

  it('throws with the attempt log when every provider fails', async () => {
    const { runChain } = await import('../src/ai/chain');
    const err: any = await runChain([fake('gemini', ['http']), fake('ollama', ['timeout'])] as any[], 's', 'u', schema)
      .catch(e => e);
    expect(err.message).toMatch(/Ningún proveedor/);
    expect(err.attempts).toHaveLength(2);
  });

  it('builds the chain from LLM_PROVIDERS and skips providers without a key', async () => {
    const { buildProviderChain } = await import('../src/ai/chain');
    const names = (env: Record<string, string | undefined>) => buildProviderChain(env).map(p => p.name);

    expect(names({ LLM_PROVIDERS: 'deepseek,gemini,ollama' })).toEqual(['ollama']);
    expect(names({ LLM_PROVIDERS: 'deepseek,gemini,ollama', GEMINI_API_KEY: 'g' })).toEqual(['gemini', 'ollama']);
    expect(names({ LLM_PROVIDERS: 'deepseek,gemini,ollama', DEEPSEEK_API_KEY: 'd', GEMINI_API_KEY: 'g' }))
      .toEqual(['deepseek', 'gemini', 'ollama']);
    // Default order (evals/REPORT.md: DeepSeek led Gemini on triage F1): DeepSeek, then Gemini, then local Qwen
    expect(names({ DEEPSEEK_API_KEY: 'd', GEMINI_API_KEY: 'g' })).toEqual(['deepseek', 'gemini', 'ollama']);
    expect(names({ GEMINI_API_KEY: 'g' })).toEqual(['gemini', 'ollama']); // no DeepSeek key: unchanged behavior
    expect(names({})).toEqual(['ollama']);
    expect(() => buildProviderChain({ LLM_PROVIDERS: 'gpt' })).toThrow(/gpt/);
  });
});
