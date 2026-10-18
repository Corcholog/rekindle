import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import { z } from 'zod';
import { isRequestAllowed } from '../../src/api/requestGuard';
import { Labels, LabelsSchema, RunDetails, RunDetailsSchema, VerdictSchema } from '../schema';
import { Dataset, loadDataset, saveLabels, validateLabels } from './dataset';
import { noteMatches } from './metrics';
import { predictionsFromDetails, scoreRun } from './scoring';

const PAGE_DIR = path.resolve(__dirname, '../review');
const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};
const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const EXCERPT_CHARS = 6000;

const LabelUpdateSchema = z.object({
  article: z.string(),
  project: z.string().optional(),
  verdict: VerdictSchema.nullable().optional(),
  target_note: z.string().nullable().optional(),
  others: VerdictSchema.nullable().optional(),
  notes: z.string().nullable().optional(),
});

async function loadRuns(dir: string): Promise<Record<string, RunDetails>> {
  const runsDir = path.join(dir, 'runs');
  const files = (await fs.readdir(runsDir).catch(() => [])).filter(f => f.endsWith('.json')).sort();
  const runs: Record<string, RunDetails> = {};
  for (const file of files) {
    const details = RunDetailsSchema.parse(JSON.parse(await fs.readFile(path.join(runsDir, file), 'utf-8')));
    runs[details.config] = details;
  }
  return runs;
}

function computeMetrics(dataset: Dataset, labels: Labels, runs: Record<string, RunDetails>) {
  return Object.fromEntries(Object.entries(runs).map(([config, details]) => [
    config,
    scoreRun({ projects: dataset.projects.map(p => p.folderPath), cases: labels.cases, predictions: predictionsFromDetails(details), k: details.k }),
  ]));
}

/** Applies one edit to the labels; throws an Error with a user-facing message if it is invalid. */
function applyUpdate(dataset: Dataset, labels: Labels, update: z.infer<typeof LabelUpdateSchema>): Labels {
  if (!dataset.articles.some(a => a.id === update.article)) throw new Error(`No existe el artículo "${update.article}"`);
  const next: Labels = structuredClone(labels);
  let labelCase = next.cases.find(c => c.article === update.article);
  if (!labelCase) {
    labelCase = { article: update.article, others: null, projects: {}, notes: null };
    next.cases.push(labelCase);
  }

  if (update.others !== undefined) labelCase.others = update.others;
  if (update.notes !== undefined) labelCase.notes = update.notes;

  if (update.project !== undefined) {
    const project = dataset.projects.find(p => p.folderPath === update.project);
    if (!project) throw new Error(`No existe el proyecto "${update.project}"`);
    const entry = (labelCase.projects[project.folderPath] ??= { verdict: null, target_note: null });

    if (update.verdict !== undefined) {
      entry.verdict = update.verdict;
      if (update.verdict !== 'actionable') entry.target_note = null; // a target only makes sense for actionable
    }
    if (update.target_note !== undefined) {
      if (update.target_note !== null && !project.notes.some(n => noteMatches(update.target_note!, n))) {
        throw new Error(`La nota "${update.target_note}" no existe en el proyecto`);
      }
      entry.target_note = update.target_note;
    }
  }

  const errors = validateLabels({ ...dataset, labels: LabelsSchema.parse(next) }, { strict: false });
  if (errors.length > 0) throw new Error(errors.join('; '));
  return next;
}

export interface ReviewServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Local page to compare every model answer with the owner's labels and correct the labels.
 * It binds to 127.0.0.1 only and applies the same Host/Origin rules as the Loom API.
 */
export async function startReviewServer(datasetDir: string, options: { port?: number } = {}): Promise<ReviewServer> {
  const dir = path.resolve(datasetDir);
  let dataset = await loadDataset(dir);
  if (!dataset.labels) throw new Error('No existe labels.yaml: genera la hoja con pnpm eval:label <dataset>');
  let labels: Labels = dataset.labels;
  const runs = await loadRuns(dir);

  // One backup per session, so every correction can be undone
  await fs.copyFile(path.join(dir, 'labels.yaml'), path.join(dir, `labels.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`));

  let writes: Promise<unknown> = Promise.resolve();
  let port = options.port ?? 0;

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 100_000) reject(new Error('Cuerpo demasiado grande')); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!isRequestAllowed({ method: req.method ?? 'GET', url: req.url ?? '/', host: req.headers.host, origin: req.headers.origin }, port)) {
        return sendJson(res, 403, { error: 'Solicitud rechazada: host u origen no permitido' });
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const file = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)], 'Cache-Control': 'no-store' });
        return res.end(await fs.readFile(path.join(PAGE_DIR, file)));
      }

      if (req.method === 'GET' && url.pathname === '/api/data') {
        return sendJson(res, 200, {
          dataset: path.basename(dir),
          projects: dataset.projects.map(p => ({ folder: p.folderPath, notes: p.notes })),
          articles: dataset.articles
            .map(a => ({ id: a.id, title: a.title, url: a.url ?? null, source: a.source, excerpt: a.text.slice(0, EXCERPT_CHARS), length: a.text.length }))
            .sort((x, y) => x.id.localeCompare(y.id)),
          labels,
          runs,
          metrics: computeMetrics(dataset, labels, runs),
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/article') {
        const article = dataset.articles.find(a => a.id === url.searchParams.get('id'));
        return article ? sendJson(res, 200, { text: article.text }) : sendJson(res, 404, { error: 'No existe el artículo' });
      }

      if (req.method === 'POST' && url.pathname === '/api/label') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return sendJson(res, 415, { error: 'Se espera application/json' });
        const parsed = LabelUpdateSchema.safeParse(JSON.parse((await readBody(req)) || '{}'));
        if (!parsed.success) return sendJson(res, 400, { error: 'Datos de etiqueta no válidos' });

        const result = await (writes = writes.then(async () => {
          const next = applyUpdate(dataset, labels, parsed.data);
          await saveLabels(dir, next);
          labels = next;
          return null;
        }).then(() => ({ ok: true as const }), (err: Error) => ({ ok: false as const, message: err.message })));

        if (!result.ok) return sendJson(res, 400, { error: result.message });
        return sendJson(res, 200, {
          case: labels.cases.find(c => c.article === parsed.data.article),
          metrics: computeMetrics(dataset, labels, runs),
        });
      }

      return sendJson(res, 404, { error: 'No encontrado' });
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  dataset = { ...dataset, labels };

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
