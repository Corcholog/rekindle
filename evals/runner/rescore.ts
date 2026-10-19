import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EvalResult, ResultSchema } from '../schema';
import { effectiveVerdict, loadDataset, loadRuns } from './dataset';
import { latestPerConfig, loadResults } from './report';
import { predictionsFromDetails, scoreRun } from './scoring';

export interface RescoreOptions {
  datasetDir: string;
  /** Config names to rescore; default: every config with a detail file in <dataset>/runs. */
  configs?: string[];
  resultsDir?: string;
  log?: (message: string) => void;
}

const gitOutput = (...args: string[]) => execFileSync('git', args, { encoding: 'utf-8' }).trim();

/**
 * Scores the predictions of each config's latest run again with the current labels, without calling
 * any model. Model calls, latency, tokens and cost stay those of the original run; retrieval and
 * triage scores are recomputed. The detail file in <dataset>/runs must come from that same config.
 */
export async function rescoreRuns(options: RescoreOptions): Promise<string[]> {
  const log = options.log ?? (() => {});
  const dataset = await loadDataset(options.datasetDir);
  const labels = dataset.labels;
  if (!labels) throw new Error('El dataset no tiene labels.yaml');
  const datasetName = path.basename(dataset.dir);
  const runs = await loadRuns(options.datasetDir);
  const resultsDir = options.resultsDir ?? path.resolve('evals/results');
  const latest = latestPerConfig(await loadResults(resultsDir)).filter(r => r.meta.dataset === datasetName);
  const cases = labels.cases.filter(c => dataset.projects.some(p => effectiveVerdict(c, p.folderPath) !== null));
  const gitSha = gitOutput('rev-parse', '--short', 'HEAD');
  const gitDirty = gitOutput('status', '--porcelain') !== '';

  const names = options.configs ?? Object.keys(runs).sort();
  const written: string[] = [];
  for (const name of names) {
    const details = runs[name];
    const previous = latest.find(r => r.meta.config === name);
    if (!details || !previous) throw new Error(`No hay detalle y resultado para «${name}» en ${datasetName}`);
    if (details.configHash !== previous.meta.configHash) {
      throw new Error(`El detalle de «${name}» no corresponde a su último resultado (configuración distinta): vuelve a ejecutarlo`);
    }

    const score = scoreRun({ projects: dataset.projects.map(p => p.folderPath), cases, predictions: predictionsFromDetails(details), k: details.k });
    const startedAt = new Date().toISOString();
    const result: EvalResult = ResultSchema.parse({
      ...previous,
      meta: {
        ...previous.meta,
        gitSha,
        gitDirty,
        datasetManifestHash: dataset.manifestHash,
        labeledBy: labels.labeled_by,
        mode: 'rescore',
        rescoredFrom: previous.meta.rescoredFrom ?? previous.meta.startedAt,
        cases: score.cases,
        labeledPairs: score.labeledPairs,
        startedAt,
      },
      retrieval: { ...score.retrieval, threshold: previous.retrieval.threshold },
      triage: score.triage,
    });

    const file = path.join(resultsDir, `${startedAt.replace(/[:.]/g, '-')}-${gitSha}-${name}-${datasetName}.json`);
    await fs.writeFile(file, JSON.stringify(result, null, 2) + '\n', 'utf-8');
    log(`  ${name}: macro-F1 ${previous.triage.macroF1?.toFixed(3)} → ${result.triage.macroF1?.toFixed(3)}`);
    written.push(file);
  }
  return written;
}
