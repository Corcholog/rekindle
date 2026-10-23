import 'dotenv/config';
import './quietLogs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { checkResult, loadThresholds } from './check';
import { generateLabelSheet, loadDataset, loadRuns, validateLabels } from './dataset';
import { renderSweep, sweepRetrieval } from './sweep';
import { latestPerConfig, loadResults, renderReport } from './report';
import { rescoreRuns } from './rescore';
import { RunMode, runEval } from './run';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      (repeated[name] ??= []).push(next);
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags, repeated };
}

const USAGE = `Uso: pnpm eval <comando>

  run <dataset> --config <archivo> [--record | --replay] [--strict] [--results-dir dir] [--details-dir dir] [--only <artículo>]...
  snapshot --vault <ruta> --out <dataset> [--project "Nombre"]...   copia de solo lectura
  fetch <dataset>                      descarga las URLs de <dataset>/sources.yaml a articles/
  label <dataset> [--check] [--strict] genera labels.yaml vacío o valida el que existe
  check --dataset <nombre> [--config <nombre>] [--thresholds <archivo>]
  rescore <dataset> [--config <nombre>]...   vuelve a puntuar las últimas ejecuciones con las etiquetas actuales, sin llamar a ningún modelo
  review <dataset> [--port N]          página local para ver las respuestas de los modelos y corregir etiquetas
  sweep <dataset> [--thresholds 0.3,0.4] [--ranks 1,2] [--write]   barrido de umbral de recuperación sin llamar a ningún modelo
  report                               regenera evals/REPORT.md
  chart [--dataset private]            regenera docs/images/eval-connections.svg`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags, repeated } = parseArgs(rest);

  switch (command) {
    case 'run': {
      const datasetDir = positional[0];
      const configPath = flags.config as string | undefined;
      if (!datasetDir || !configPath) throw new Error('run necesita <dataset> y --config <archivo>');
      const mode: RunMode = flags.replay ? 'replay' : flags.record ? 'record' : 'live';
      const { result, resultFile } = await runEval({
        datasetDir, configPath, mode, strict: Boolean(flags.strict), resultsDir: flags['results-dir'] as string | undefined, detailsDir: flags['details-dir'] as string | undefined,
        only: repeated.only, log: m => console.log(m),
      });
      console.log(`\nResultado: ${resultFile}`);
      console.log(JSON.stringify({ retrieval: result.retrieval, macroF1: result.triage.macroF1, reliability: result.reliability, cost: result.cost }, null, 2));
      break;
    }
    case 'snapshot': {
      const vault = flags.vault as string | undefined;
      const out = flags.out as string | undefined;
      if (!vault || !out) throw new Error('snapshot necesita --vault y --out');
      await snapshotVault(vault, out, repeated.project ?? []);
      break;
    }
    case 'fetch': {
      if (!positional[0]) throw new Error('fetch necesita <dataset>');
      await fetchSources(positional[0]);
      break;
    }
    case 'label': {
      const dir = positional[0];
      if (!dir) throw new Error('label necesita <dataset>');
      if (flags.check) {
        const errors = validateLabels(await loadDataset(dir), { strict: Boolean(flags.strict) });
        if (errors.length > 0) { console.error(errors.map(e => `- ${e}`).join('\n')); process.exitCode = 1; }
        else console.log('Etiquetas válidas.');
      } else {
        await generateLabelSheet(dir);
        console.log(`Hoja de etiquetas lista en ${path.join(dir, 'labels.yaml')}: rellena los veredictos.`);
      }
      break;
    }
    case 'check': {
      const dataset = flags.dataset as string | undefined;
      if (!dataset) throw new Error('check necesita --dataset <nombre>');
      const thresholds = await loadThresholds((flags.thresholds as string) ?? 'evals/configs/thresholds.json');
      const results = latestPerConfig(await loadResults('evals/results'))
        .filter(r => r.meta.dataset === dataset && (!flags.config || r.meta.config === flags.config));
      if (results.length === 0) throw new Error('No hay resultados para ese dataset/configuración');
      const failures = results.flatMap(r => checkResult(r, thresholds));
      if (failures.length > 0) { console.error(failures.map(f => `- ${f}`).join('\n')); process.exitCode = 1; }
      else console.log(`Todas las comprobaciones pasan (${results.length} resultado(s)).`);
      break;
    }
    case 'rescore': {
      const dir = positional[0];
      if (!dir) throw new Error('rescore necesita <dataset>');
      const files = await rescoreRuns({ datasetDir: dir, configs: repeated.config, log: m => console.log(m) });
      console.log(`${files.length} resultado(s) nuevos en evals/results; ejecuta pnpm eval:report.`);
      break;
    }
    case 'review': {
      const dir = positional[0];
      if (!dir) throw new Error('review necesita <dataset>');
      const { startReviewServer } = await import('./review');
      const server = await startReviewServer(dir, { port: Number(flags.port ?? 3210) });
      console.log(`Revisión de etiquetas en ${server.url}  (Ctrl+C para terminar)`);
      await new Promise(() => {}); // serve until interrupted
      break;
    }
    case 'sweep': {
      const dir = positional[0];
      if (!dir) throw new Error('sweep necesita <dataset>');
      const dataset = await loadDataset(dir);
      if (!dataset.labels) throw new Error('El dataset no tiene labels.yaml');
      const runs = await loadRuns(dir);
      if (Object.keys(runs).length === 0) throw new Error('No hay ejecuciones en <dataset>/runs: ejecuta pnpm eval run … primero');
      const thresholds = String(flags.thresholds ?? '0.30,0.35,0.40,0.45,0.50,0.55,0.60').split(',').map(Number);
      const ranks = String(flags.ranks ?? '1,2,3,4').split(',').filter(Boolean).map(Number);
      const combos: [number, number][] = [[0.55, 3], [0.50, 3], [0.55, 2]];
      const result = sweepRetrieval({ projects: dataset.projects.map(p => p.folderPath), cases: dataset.labels.cases, runs, thresholds, ranks, combos });
      const markdown = renderSweep(path.basename(path.resolve(dir)), result, Object.keys(runs).sort());
      if (flags.write) { await fs.writeFile('evals/SWEEP.md', markdown, 'utf-8'); console.log('evals/SWEEP.md actualizado.'); }
      else console.log(markdown);
      break;
    }
    case 'chart': {
      const { chartPoints, renderChart } = await import('./chart');
      const svg = renderChart(chartPoints(await loadResults('evals/results'), String(flags.dataset ?? 'private')));
      await fs.writeFile('docs/images/eval-connections.svg', svg, 'utf-8');
      console.log('docs/images/eval-connections.svg actualizado.');
      break;
    }
    case 'report': {
      await fs.writeFile('evals/REPORT.md', renderReport(await loadResults('evals/results')), 'utf-8');
      console.log('evals/REPORT.md actualizado.');
      break;
    }
    default:
      console.log(USAGE);
      if (command) process.exitCode = 1;
  }
}

/** Read-only copy of project notes (markdown only) into a dataset directory. */
async function snapshotVault(vault: string, out: string, only: string[]): Promise<void> {
  let copied = 0;
  for (const root of ['Projects', 'Proyectos']) {
    const rootDir = path.join(vault, root);
    const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (only.length > 0 && !only.includes(entry.name)) continue;
      copied += await copyMarkdown(path.join(rootDir, entry.name), path.join(out, 'vault', root, entry.name));
      console.log(`  ${root}/${entry.name}`);
    }
  }
  console.log(`${copied} notas copiadas a ${path.join(out, 'vault')} (el vault original no se modifica).`);
}

async function copyMarkdown(from: string, to: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const source = path.join(from, entry.name);
    if (entry.isDirectory()) count += await copyMarkdown(source, path.join(to, entry.name));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'suggestions.md') {
      await fs.mkdir(to, { recursive: true });
      await fs.copyFile(source, path.join(to, entry.name));
      count++;
    }
  }
  return count;
}

/** Downloads <dataset>/sources.yaml ({id, url, title?}[]) into articles/<id>.json using Rekindle's own ingestion code. */
async function fetchSources(dir: string): Promise<void> {
  const { default: YAML } = await import('yaml');
  const { z } = await import('zod');
  const sources = z.array(z.object({ id: z.string(), url: z.string().url(), title: z.string().optional() }))
    .parse(YAML.parse(await fs.readFile(path.join(dir, 'sources.yaml'), 'utf-8')));
  const { fetchPublicPage } = await import('../../src/net/safeFetch');
  const { isYouTubeUrl, extractYouTubeContent } = await import('../../src/workers/ingestionWorker');
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');

  await fs.mkdir(path.join(dir, 'articles'), { recursive: true });
  for (const source of sources) {
    try {
      let title = source.title ?? source.id;
      let text: string;
      if (isYouTubeUrl(source.url)) {
        const video = await extractYouTubeContent(source.url);
        title = source.title ?? video.title;
        text = video.rawText;
      } else {
        const page = await fetchPublicPage(source.url);
        const article = new Readability(new JSDOM(page.text, { url: page.finalUrl }).window.document).parse();
        if (!article?.textContent) throw new Error('Readability no pudo extraer el texto');
        title = source.title ?? article.title ?? source.id;
        text = article.textContent.trim().substring(0, 50000);
      }
      await fs.writeFile(path.join(dir, 'articles', `${source.id}.json`), JSON.stringify({ id: source.id, title, url: source.url, source: 'real', text }, null, 2));
      console.log(`  ✓ ${source.id} (${text.length} caracteres)`);
    } catch (err) {
      console.error(`  ✗ ${source.id}: ${(err as Error).message}`);
    }
  }
}

main().then(() => process.exit(process.exitCode ?? 0), err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
