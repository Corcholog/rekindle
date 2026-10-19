import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';

// The label review page: a local server that shows every model answer next to the owner's labels
// and writes corrections to labels.yaml. It only accepts requests meant for 127.0.0.1.
describe('label review server', () => {
  let dir: string;
  let base: string;
  let close: () => Promise<void>;
  let port: number;

  const detail = (verdict: string, reasoning: string, target: string | null = null) => ({
    verdict, confidence: 0.8, reasoning,
    action: target ? { type: 'evidence_citation', observation: 'obs', suggestedAction: 'acción', targetFile: target } : null,
  });

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-review-'));
    await fs.cp('tests/fixtures/eval-mini', dir, { recursive: true });
    await fs.rm(path.join(dir, 'cache'), { recursive: true, force: true });
    await fs.mkdir(path.join(dir, 'runs'));
    // A fake model that calls the football article actionable for Cocina (the label says irrelevant)
    await fs.writeFile(path.join(dir, 'runs', 'modelo-a.json'), JSON.stringify({
      config: 'modelo-a', configHash: 'x', generatedAt: '2026-01-01T00:00:00Z', k: 2, threshold: 0.6,
      articles: {
        'muerte-anime': { summary: 'Resumen A', retrieval: [{ project: 'Projects/Anime', distance: 0.2, level: 'note', note: 'ideas.md' }],
          pairs: { 'Projects/Anime': detail('actionable', 'La muerte cambia el tono', 'muerte-de-personajes.md') } },
        'pan-masa-madre': { summary: 'Resumen B', retrieval: [{ project: 'Projects/Cocina', distance: 0.3, level: 'project', note: null }],
          pairs: { 'Projects/Cocina': detail('actionable', 'Receta útil', 'recetas.md') } },
        'futbol-liga': { summary: 'Resumen C', retrieval: [{ project: 'Projects/Cocina', distance: 0.55, level: 'project', note: null }],
          pairs: { 'Projects/Cocina': detail('actionable', 'Quizá', 'recetas.md') } },
      },
    }));

    const { startReviewServer } = await import('../evals/runner/review');
    const server = await startReviewServer(dir, { port: 0 });
    base = server.url;
    port = new URL(server.url).port as unknown as number;
    close = server.close;
  });
  afterAll(async () => {
    await close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/label`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const labelsOnDisk = async () => YAML.parse(await fs.readFile(path.join(dir, 'labels.yaml'), 'utf-8'));

  it('serves the page and the data: articles, projects, labels, every model answer and live metrics', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('Revisión de etiquetas');

    const data = await (await fetch(`${base}/api/data`)).json();
    expect(data.articles.map((a: any) => a.id)).toEqual(['futbol-liga', 'muerte-anime', 'pan-masa-madre']);
    expect(data.projects.find((p: any) => p.folder === 'Projects/Anime').notes).toContain('muerte-de-personajes.md');
    expect(data.labels.labeled_by).toBe('test-fixture');
    expect(data.runs['modelo-a'].articles['futbol-liga'].pairs['Projects/Cocina'].reasoning).toBe('Quizá');
    // football x Cocina: label irrelevant, model actionable -> one irrelevant->actionable error
    expect(data.metrics['modelo-a'].triage.confusion.irrelevant.actionable).toBe(1);
  });

  it('saves a corrected label to labels.yaml, keeps a backup and recomputes the metrics', async () => {
    const res = await post({ article: 'futbol-liga', project: 'Projects/Cocina', verdict: 'tentative' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics['modelo-a'].triage.confusion.tentative.actionable).toBe(1);
    expect(body.metrics['modelo-a'].triage.confusion.irrelevant.actionable).toBe(0);

    const saved = (await labelsOnDisk()).cases.find((c: any) => c.article === 'futbol-liga');
    expect(saved.projects['Projects/Cocina'].verdict).toBe('tentative');
    expect(saved.projects['Projects/Anime'].verdict).toBe('irrelevant'); // untouched

    const backups = (await fs.readdir(dir)).filter(f => f.startsWith('labels.backup-'));
    expect(backups).toHaveLength(1);
    expect(YAML.parse(await fs.readFile(path.join(dir, backups[0]), 'utf-8')).cases.find((c: any) => c.article === 'futbol-liga')
      .projects['Projects/Cocina'].verdict).toBe('irrelevant');
  });

  it('sets the target note only for actionable labels and only from the project\'s notes', async () => {
    const ok = await post({ article: 'muerte-anime', project: 'Projects/Anime', target_note: 'ideas.md' });
    expect(ok.status).toBe(200);
    expect((await labelsOnDisk()).cases.find((c: any) => c.article === 'muerte-anime').projects['Projects/Anime'].target_note).toBe('ideas.md');

    expect((await post({ article: 'muerte-anime', project: 'Projects/Anime', target_note: 'no-existe.md' })).status).toBe(400);

    // Leaving "actionable" drops the target note
    await post({ article: 'muerte-anime', project: 'Projects/Anime', verdict: 'tentative' });
    expect((await labelsOnDisk()).cases.find((c: any) => c.article === 'muerte-anime').projects['Projects/Anime'].target_note).toBeNull();
  });

  it('supports the "others" shortcut and rejects unknown projects or articles without touching the file', async () => {
    expect((await post({ article: 'pan-masa-madre', others: 'tentative' })).status).toBe(200);
    expect((await labelsOnDisk()).cases.find((c: any) => c.article === 'pan-masa-madre').others).toBe('tentative');

    const before = await fs.readFile(path.join(dir, 'labels.yaml'), 'utf-8');
    expect((await post({ article: 'pan-masa-madre', project: 'Projects/Fantasma', verdict: 'actionable' })).status).toBe(400);
    expect((await post({ article: 'no-existe', others: 'irrelevant' })).status).toBe(400);
    expect((await post({ article: 'pan-masa-madre', project: 'Projects/Cocina', verdict: 'genial' })).status).toBe(400);
    expect(await fs.readFile(path.join(dir, 'labels.yaml'), 'utf-8')).toBe(before);
  });

  it('only accepts loopback hosts and same-origin writes, and serves nothing outside its folder', async () => {
    const withHost = (host: string, url = '/api/data') => new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: url, headers: { host } }, res => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
    });
    expect(await withHost('evil.example:80')).toBe(403);
    expect(await withHost(`127.0.0.1:${port}`)).toBe(200);

    expect((await post({ article: 'pan-masa-madre', others: 'irrelevant' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${base}/api/label`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect(await withHost(`127.0.0.1:${port}`, '/..%2f..%2fpackage.json')).toBe(404);
    expect(await withHost(`127.0.0.1:${port}`, '/labels.yaml')).toBe(404);
  });

  it('returns the full article text on request', async () => {
    const res = await (await fetch(`${base}/api/article?id=pan-masa-madre`)).json();
    expect(res.text).toContain('masa madre');
    expect((await fetch(`${base}/api/article?id=../../etc/passwd`)).status).toBe(404);
  });
});
