import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

// An eval run against a rate-limited provider waits and retries the SAME provider, never falls
// back to another model, and reports the hits. Embeddings and summaries come from the cache.
describe('eval run under rate limiting', () => {
  let server: http.Server;
  let baseUrl: string;
  let tmp: string;
  let limitedFirst = 0; // answer 429 to the next N requests
  let alwaysLimited = false;
  let requests = 0;

  const triage = JSON.stringify({
    choices: [{ message: { content: '{"verdict":"irrelevant","confidenceScore":0.1,"triageReasoning":"x","action":null}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      requests++;
      if (alwaysLimited || limitedFirst > 0) {
        limitedFirst--;
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(triage);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-evalrl-'));
    await fs.cp('tests/fixtures/eval-mini', tmp, { recursive: true });
    await fs.rm(path.join(tmp, 'cache', 'llm.json'));
    await fs.writeFile(path.join(tmp, 'config.json'), JSON.stringify({
      name: 'mini-limited',
      providers: [{ name: 'deepseek', thinking: false }, { name: 'ollama' }],
      summaryProviders: [{ name: 'ollama' }], // cached
      k: 2,
      rateLimit: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 10 },
    }));
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  beforeEach(() => { requests = 0; limitedFirst = 0; alwaysLimited = false; });

  async function run() {
    vi.resetModules();
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    vi.stubEnv('DEEPSEEK_BASE_URL', baseUrl);
    vi.stubEnv('OLLAMA_URL', 'http://127.0.0.1:9'); // a fallback to Ollama would fail loudly
    const { runEval } = await import('../evals/runner/run');
    return runEval({ datasetDir: tmp, configPath: path.join(tmp, 'config.json'), mode: 'live', maxUsd: 1, resultsDir: tmp });
  }

  it('waits through transient 429s and still gets every answer from the same provider', async () => {
    limitedFirst = 2;
    const { result } = await run();

    expect(result.reliability.rateLimitHits).toBe(2);
    expect(result.reliability.rateLimitWaitMs).toBeGreaterThan(0);
    expect(result.reliability.failures).toBe(0);
    expect(result.reliability.fallbacks).toBe(0);
  }, 180000);

  it('reports failures instead of falling back when the limit never lifts', async () => {
    alwaysLimited = true;
    const { result } = await run();

    expect(result.reliability.failures).toBe(result.reliability.llmCalls);
    expect(result.reliability.failures).toBeGreaterThan(0);
    expect(result.reliability.fallbacks).toBe(0);
    expect(result.reliability.rateLimitHits).toBe(result.reliability.failures * 3); // first try + 2 retries each
  }, 180000);
});
