import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// The eval harness end to end, offline: real Postgres (Testcontainers), real reconciler,
// retrieval and evaluator, with embeddings, summaries and LLM answers replayed from the
// recorded cache of tests/fixtures/eval-mini. The labels there are a machinery fixture.
const DATASET = 'tests/fixtures/eval-mini';
const CONFIG = `${DATASET}/config.json`;

describe('eval harness replay', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  async function replay() {
    // runEval binds the config and the DB pool at first import, so each run needs fresh modules
    vi.resetModules();
    const { runEval } = await import('../evals/runner/run');
    const resultsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-evalresults-'));
    dirs.push(resultsDir);
    return runEval({ datasetDir: DATASET, configPath: CONFIG, mode: 'replay', maxUsd: 0, resultsDir });
  }

  it('reproduces identical numbers twice without any model or network', async () => {
    vi.stubEnv('OLLAMA_URL', 'http://127.0.0.1:9'); // closed port: any live embedding would fail
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const first = await replay();
    const second = await replay();

    const stable = (r: typeof first.result) => ({ ...r, meta: { ...r.meta, startedAt: '' } });
    expect(stable(second.result)).toEqual(stable(first.result));

    const { result } = first;
    expect(result.meta).toMatchObject({ mode: 'replay', labeledBy: 'test-fixture', cases: 3, labeledPairs: 6, embeddingModel: 'bge-m3' });
    expect(result.retrieval).toMatchObject({ k: 2, precisionAtK: 1, recallAtK: 1, casesWithRelevant: 2, casesWithoutRelevant: 1 });
    expect(result.triage.macroF1).toBe(1);
    expect(result.triage).toMatchObject({ targetNoteAccuracy: 0.5, targetNoteCases: 2 }); // recorded: one of two target notes was right
    expect(result.reliability).toMatchObject({ llmCalls: 3, failures: 0, fallbacks: 0, malformedOutputs: 0 });
    expect(result.cost.estimatedUsd).toBe(0);

    const llmCalls = fetchSpy.mock.calls.filter(([url]) => !String(url).startsWith('http://127.0.0.1:') || !String(url).includes(':9')).length;
    expect(llmCalls).toBe(0);
    fetchSpy.mockRestore();
  }, 180000);

  it('writes aggregate numbers only: no note or article text reaches the result file', async () => {
    const { resultFile } = await replay();
    const raw = await fs.readFile(resultFile, 'utf-8');
    for (const secret of ['Evangelion', 'Attack on Titan', 'masa madre', 'fermentación', 'estadio', 'Muerte de personajes']) {
      expect(raw).not.toContain(secret);
    }
  }, 180000);

  it('refuses to replay when the cache lacks an entry', async () => {
    vi.resetModules();
    const { runEval } = await import('../evals/runner/run');
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-evalcopy-'));
    dirs.push(copy);
    await fs.cp(DATASET, copy, { recursive: true });
    await fs.rm(path.join(copy, 'cache', 'llm.json'));

    await expect(runEval({
      datasetDir: copy, configPath: path.join(copy, 'config.json'), mode: 'replay', maxUsd: 0, resultsDir: copy,
    })).rejects.toThrow(/replay/i);
  }, 180000);
});
