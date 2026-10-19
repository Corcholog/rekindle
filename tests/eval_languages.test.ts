import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConfigSchema } from '../evals/schema';

// Language experiments in the eval harness: configs without a languages block keep their hash
// (so earlier results still match), and a language change really changes the prompts.

describe('eval language configs', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('leave the hash of existing configs unchanged', async () => {
    const { loadConfig } = await import('../evals/runner/run');
    const results = (await fs.readdir('evals/results')).filter(f => f.includes('ce14538') && f.endsWith('-private.json'));
    expect(results.length).toBeGreaterThan(0);
    for (const file of results) {
      const result = JSON.parse(await fs.readFile(path.join('evals/results', file), 'utf-8'));
      const { hash } = await loadConfig(`evals/configs/${result.meta.config}.json`);
      expect(hash, result.meta.config).toBe(result.meta.configHash);
    }
  });

  it('accept only es and en', () => {
    const base = { name: 'x', providers: [{ name: 'ollama' }], summaryProviders: [{ name: 'ollama' }] };
    expect(ConfigSchema.parse({ ...base, languages: { output: 'en' } }).languages).toEqual({ output: 'en' });
    expect(() => ConfigSchema.parse({ ...base, languages: { prompt: 'fr' } })).toThrow();
  });

  it('change the triage prompt (the replay cache misses) and restore the language settings afterwards', async () => {
    vi.stubEnv('OLLAMA_URL', 'http://127.0.0.1:9');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('OUTPUT_LANGUAGE', 'es');
    const config = JSON.parse(await fs.readFile('tests/fixtures/eval-mini/config.json', 'utf-8'));
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-evallang-'));
    dirs.push(tmp);
    const configPath = path.join(tmp, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ ...config, name: 'mini-ollama-output-en', languages: { output: 'en' } }));

    vi.resetModules();
    const { runEval } = await import('../evals/runner/run');
    await expect(runEval({ datasetDir: 'tests/fixtures/eval-mini', configPath, mode: 'replay', maxUsd: 0, resultsDir: tmp, detailsDir: tmp }))
      .rejects.toThrow(/replay/i);
    expect(process.env.OUTPUT_LANGUAGE).toBe('es');
    expect(process.env.PROMPT_LANGUAGE).toBeUndefined();
  }, 180000);
});
