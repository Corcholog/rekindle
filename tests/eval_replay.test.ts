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
    const resultsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-evalresults-'));
    dirs.push(resultsDir);
    const run = await runEval({ datasetDir: DATASET, configPath: CONFIG, mode: 'replay', resultsDir, detailsDir: resultsDir });
    return { ...run, detailsFile: path.join(resultsDir, 'mini-ollama.json') };
  }

  it('reproduces identical numbers twice without any model or network', async () => {
    vi.stubEnv('OLLAMA_URL', 'http://127.0.0.1:9'); // closed port: any live embedding would fail
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const first = await replay();
    const second = await replay();

    // Wall-clock fields differ between runs; everything else must match
    const stable = (r: typeof first.result) => ({
      ...r,
      meta: { ...r.meta, startedAt: '' },
      telemetry: r.telemetry && { ...r.telemetry, stages: r.telemetry.stages.map(s => ({ ...s, p50Ms: 0, p95Ms: 0 })) },
    });
    expect(stable(second.result)).toEqual(stable(first.result));

    const { result } = first;
    expect(result.meta).toMatchObject({ mode: 'replay', labeledBy: 'test-fixture', cases: 3, labeledPairs: 6, embeddingModel: 'bge-m3' });
    expect(result.retrieval).toMatchObject({ k: 2, precisionAtK: 1, recallAtK: 1, casesWithRelevant: 2, casesWithoutRelevant: 1 });
    expect(result.triage.macroF1).toBe(1);
    expect(result.triage).not.toHaveProperty('targetNoteAccuracy');
    // 3 triage calls, and 2 calls that lay out the text of the two actionable answers
    expect(result.reliability).toMatchObject({ llmCalls: 3, failures: 0, fallbacks: 0, malformedOutputs: 0, structure: { calls: 2, failures: 0 } });
    expect(result.cost.estimatedUsd).toBe(0);

    // The production telemetry of the run agrees with the harness's own accounting
    expect(result.telemetry).toMatchObject({ llmCalls: result.reliability.llmCalls + result.reliability.structure!.calls, failedCalls: 0, fallbackCalls: 0 });
    expect(result.telemetry!.stages.map(s => s.stage)).toEqual(['evaluate', 'evaluate_job', 'retrieve']);
    expect(result.telemetry!.stages.find(s => s.stage === 'evaluate_job')!.events).toBe(3);

    const llmCalls = fetchSpy.mock.calls.filter(([url]) => !String(url).startsWith('http://127.0.0.1:') || !String(url).includes(':9')).length;
    expect(llmCalls).toBe(0);
    fetchSpy.mockRestore();
  }, 180000);

  it('keeps a detail file whose re-scoring reproduces the run exactly', async () => {
    const { result, detailsFile } = await replay();
    const { RunDetailsSchema } = await import('../evals/schema');
    const { scoreRun, predictionsFromDetails, targetNoteStats, suggestionTextStats } = await import('../evals/runner/scoring');
    const { loadDataset } = await import('../evals/runner/dataset');

    const details = RunDetailsSchema.parse(JSON.parse(await fs.readFile(detailsFile, 'utf-8')));
    expect(Object.values(details.articles).every(a => /^[0-9a-f-]{36}$/.test(a.traceId ?? ''))).toBe(true);
    const dataset = await loadDataset(DATASET);
    const rescored = scoreRun({
      projects: dataset.projects.map(p => p.folderPath), cases: dataset.labels!.cases,
      predictions: predictionsFromDetails(details), k: details.k,
    });

    expect({ ...rescored.triage, targetNotes: targetNoteStats(details), text: suggestionTextStats(details) }).toEqual(result.triage);
    expect(result.triage.targetNotes).toMatchObject({ actions: 2 });
    expect(rescored.retrieval).toMatchObject({ precisionAtK: result.retrieval.precisionAtK, recallAtK: result.retrieval.recallAtK });
    // The page needs the models' reasons, the summaries and the retrieval distances
    const article = details.articles['muerte-anime'];
    expect(article.summary.length).toBeGreaterThan(10);
    expect(article.retrieval[0].distance).toBeGreaterThan(0);
    expect(Object.values(article.pairs).some(p => (p.reasoning ?? '').length > 5)).toBe(true);
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
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-evalcopy-'));
    dirs.push(copy);
    await fs.cp(DATASET, copy, { recursive: true });
    await fs.rm(path.join(copy, 'cache', 'llm.json'));

    await expect(runEval({
      datasetDir: copy, configPath: path.join(copy, 'config.json'), mode: 'replay', resultsDir: copy,
    })).rejects.toThrow(/replay/i);
  }, 180000);
});
