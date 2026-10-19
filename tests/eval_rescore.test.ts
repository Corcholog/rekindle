import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { loadDataset } from '../evals/runner/dataset';
import { loadResults } from '../evals/runner/report';
import { rescoreRuns } from '../evals/runner/rescore';
import { predictionsFromDetails, scoreRun } from '../evals/runner/scoring';

// Rescoring reuses a run's predictions with edited labels: no model call, the run's cost kept.
describe('eval rescore', () => {
  let root: string;
  let dir: string;
  let resultsDir: string;

  const pair = (verdict: string) => ({ verdict, confidence: 0.7, reasoning: 'r', action: null });
  const details = {
    config: 'modelo', configHash: 'hash-1', generatedAt: '2026-01-01T00:00:00Z', k: 2, threshold: 0.6,
    articles: {
      'muerte-anime': { summary: 'R', retrieval: [{ project: 'Projects/Anime', distance: 0.2, level: 'project', note: null }], pairs: { 'Projects/Anime': pair('actionable') } },
      'pan-masa-madre': { summary: 'R', retrieval: [{ project: 'Projects/Cocina', distance: 0.3, level: 'project', note: null }], pairs: { 'Projects/Cocina': pair('actionable') } },
      'futbol-liga': { summary: 'R', retrieval: [{ project: 'Projects/Cocina', distance: 0.5, level: 'project', note: null }], pairs: { 'Projects/Cocina': pair('tentative') } },
    },
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-rescore-'));
    dir = path.join(root, 'mini');
    resultsDir = path.join(root, 'results');
    await fs.cp('tests/fixtures/eval-mini', dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'runs'));
    await fs.mkdir(resultsDir);
    await fs.writeFile(path.join(dir, 'runs', 'modelo.json'), JSON.stringify(details));

    // The original run's result, scored with the fixture's labels
    const dataset = await loadDataset(dir);
    const score = scoreRun({ projects: dataset.projects.map(p => p.folderPath), cases: dataset.labels!.cases, predictions: predictionsFromDetails(details as any), k: 2 });
    await fs.writeFile(path.join(resultsDir, '2026-01-01T00-00-00-000Z-abc-modelo-mini.json'), JSON.stringify({
      meta: {
        gitSha: 'abc', gitDirty: false, config: 'modelo', configHash: 'hash-1', dataset: 'mini', datasetManifestHash: dataset.manifestHash,
        labeledBy: 'test-fixture', mode: 'record', embeddingModel: 'bge-m3', cases: score.cases, labeledPairs: score.labeledPairs, startedAt: '2026-01-01T00:00:00.000Z',
      },
      retrieval: { ...score.retrieval, threshold: 0.6 },
      triage: score.triage,
      reliability: { llmCalls: 3, attempts: 3, malformedOutputs: 0, fallbacks: 0, failures: 0, rateLimitHits: 0, unavailableHits: 0, rateLimitWaitMs: 0, latencyMsP50: 100, latencyMsP95: 200 },
      cost: { promptTokens: 300, completionTokens: 30, estimatedUsd: 0.001, note: 'original run' },
    }));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('scores the same predictions with the edited labels and keeps the run\'s calls and cost', async () => {
    const before = (await loadResults(resultsDir))[0];
    // futbol-liga × Cocina: the model said tentative; the owner now agrees there is a connection
    const labels = YAML.parse(await fs.readFile(path.join(dir, 'labels.yaml'), 'utf-8'));
    labels.cases.find((c: any) => c.article === 'futbol-liga').projects['Projects/Cocina'].verdict = 'tentative';
    await fs.writeFile(path.join(dir, 'labels.yaml'), YAML.stringify(labels));

    const files = await rescoreRuns({ datasetDir: dir, resultsDir });
    expect(files).toHaveLength(1);
    const after = (await loadResults(resultsDir)).find(r => r.meta.mode === 'rescore')!;

    expect(after.meta).toMatchObject({ config: 'modelo', configHash: 'hash-1', rescoredFrom: '2026-01-01T00:00:00.000Z' });
    expect(after.meta.datasetManifestHash).not.toBe(before.meta.datasetManifestHash);
    expect(after.reliability).toEqual(before.reliability);
    expect(after.cost).toEqual(before.cost);
    expect(before.triage.connection).toMatchObject({ precision: 2 / 3, recall: 1 });
    expect(after.triage.connection).toMatchObject({ precision: 1, recall: 1 });
    expect(after.triage.perClass.tentative.f1).toBe(1);

    // Rescoring a rescore points back to the run that made the predictions
    await rescoreRuns({ datasetDir: dir, resultsDir });
    const again = (await loadResults(resultsDir)).filter(r => r.meta.mode === 'rescore');
    expect(again.map(r => r.meta.rescoredFrom)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });

  it('refuses a detail file from a different config than the latest result', async () => {
    await fs.writeFile(path.join(dir, 'runs', 'modelo.json'), JSON.stringify({ ...details, configHash: 'hash-2' }));
    await expect(rescoreRuns({ datasetDir: dir, resultsDir })).rejects.toThrow(/no corresponde/);
  });
});
