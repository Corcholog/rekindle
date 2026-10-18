import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

describe('eval budget guard', () => {
  let server: http.Server;
  let requests = 0;
  let baseUrl: string;
  let tmp: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"verdict":"irrelevant","confidenceScore":0.1,"triageReasoning":"x","action":null}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Copy the fixture so the cache files of the repository stay untouched
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-evalbudget-'));
    await fs.cp('tests/fixtures/eval-mini', tmp, { recursive: true });
    await fs.rm(path.join(tmp, 'cache', 'llm.json'));
    await fs.writeFile(path.join(tmp, 'config.json'), JSON.stringify({
      name: 'mini-deepseek',
      providers: [{ name: 'deepseek' }],
      summaryProviders: [{ name: 'ollama' }], // summaries and embeddings come from the cache
      k: 2,
      prices: { 'deepseek:deepseek-flash': { inputPerM: 1_000_000, outputPerM: 1_000_000 } }, // absurd on purpose
    }));
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('aborts before spending when the estimate exceeds the cap, without calling the provider', async () => {
    vi.resetModules();
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    vi.stubEnv('DEEPSEEK_BASE_URL', baseUrl);
    vi.stubEnv('OLLAMA_URL', 'http://127.0.0.1:9');

    const { runEval } = await import('../evals/runner/run');
    await expect(runEval({
      datasetDir: tmp, configPath: path.join(tmp, 'config.json'), mode: 'live', maxUsd: 0.01, resultsDir: tmp,
    })).rejects.toThrow(/EVAL_MAX_USD/);
    expect(requests).toBe(0);
  }, 180000);
});

describe('eval regression check', () => {
  const result = (overrides: object = {}) => ({
    meta: { config: 'c', dataset: 'd' },
    retrieval: { recallAtK: 0.9 },
    triage: { macroF1: 0.7 },
    reliability: { failures: 0 },
    ...overrides,
  }) as any;
  const thresholds = {
    checks: [
      { path: 'retrieval.recallAtK', min: 0.8 },
      { path: 'triage.macroF1', min: 0.5 },
      { path: 'reliability.failures', max: 0 },
    ],
  };

  it('passes when every metric is within bounds', async () => {
    const { checkResult } = await import('../evals/runner/check');
    expect(checkResult(result(), thresholds)).toEqual([]);
  });

  it('fails when a metric drops below its minimum, exceeds its maximum or was not measured', async () => {
    const { checkResult } = await import('../evals/runner/check');
    const failures = checkResult(result({
      triage: { macroF1: 0.4 }, reliability: { failures: 2 }, retrieval: { recallAtK: null },
    }), thresholds);
    expect(failures).toHaveLength(3);
    expect(failures.join('\n')).toMatch(/macroF1 = 0\.400 < mínimo 0\.5/);
    expect(failures.join('\n')).toMatch(/failures = 2\.000 > máximo 0/);
    expect(failures.join('\n')).toMatch(/recallAtK no se midió/);
  });
});
