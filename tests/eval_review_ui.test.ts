import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import { JSDOM } from 'jsdom';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';

// Runs the real page script in jsdom against the real review server: no browser needed.
describe('label review page (DOM)', () => {
  let dir: string;
  let base: string;
  let close: () => Promise<void>;
  let dom: JSDOM;

  const waitFor = async (check: () => boolean, what: string | (() => string)) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${typeof what === 'function' ? what() : what}`);
  };
  const doc = () => dom.window.document;
  const openArticle = async (id: string) => {
    const item = [...doc().querySelectorAll('#article-list li')].find(li => li.querySelector('.chip.source')!.textContent === id)!;
    (item.querySelector('button') as HTMLButtonElement).click();
    await waitFor(() => doc().querySelector('#detail .detail-head p')!.textContent!.startsWith(id), `the detail of ${id}`);
  };

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-reviewui-'));
    await fs.cp('tests/fixtures/eval-mini', dir, { recursive: true });
    await fs.rm(path.join(dir, 'cache'), { recursive: true, force: true });
    await fs.mkdir(path.join(dir, 'runs'));
    const pair = (verdict: string, reasoning: string) => ({ verdict, confidence: 0.7, reasoning, action: null });
    await fs.writeFile(path.join(dir, 'runs', 'modelo-a.json'), JSON.stringify({
      config: 'modelo-a', configHash: 'x', generatedAt: '2026-01-01T00:00:00Z', k: 2, threshold: 0.6,
      articles: {
        'muerte-anime': { summary: 'Resumen <b>con html</b>', retrieval: [{ project: 'Projects/Anime', distance: 0.2, level: 'project', note: null }],
          pairs: { 'Projects/Anime': pair('actionable', 'Razón <img src=x onerror=alert(1)>') } },
        'pan-masa-madre': { summary: 'R', retrieval: [], pairs: {} },
        'futbol-liga': { summary: 'R', retrieval: [{ project: 'Projects/Cocina', distance: 0.5, level: 'project', note: null }],
          pairs: { 'Projects/Cocina': pair('tentative', 'Quizá') } },
      },
    }));

    const { startReviewServer } = await import('../evals/runner/review');
    const server = await startReviewServer(dir, { port: 0 });
    base = server.url;
    close = server.close;

    const html = (await (await fetch(`${base}/`)).text()).replace(/<script[^>]*><\/script>/, '');
    dom = new JSDOM(html, { runScripts: 'outside-only', url: `${base}/` });
    (dom.window as any).fetch = (url: string, init?: RequestInit) => fetch(new URL(url, base), init);
    (dom.window as any).structuredClone = structuredClone; // real browsers have it; jsdom does not
    dom.window.eval(await (await fetch(`${base}/app.js`)).text());
    await waitFor(() => doc().querySelectorAll('#article-list button').length === 3, () => `the article list (subtitle: ${doc().getElementById('subtitle')!.textContent})`);
  });
  afterAll(async () => {
    dom?.window.close();
    await close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists the articles, shows a metrics card per model and renders model text as text, never HTML', async () => {
    expect(doc().querySelectorAll('.metric-card')).toHaveLength(1);
    expect(doc().querySelector('.metric-card h2')!.textContent).toBe('modelo-a');

    const titles = [...doc().querySelectorAll('.article-title')].map(e => e.textContent);
    expect(titles).toContain('El peso de la pérdida en el anime moderno');

    // Markup injected through the summary and the model's reasoning must not become elements
    await openArticle('muerte-anime');
    expect(doc().querySelector('#detail img')).toBeNull();
    expect(doc().querySelector('#detail b')).toBeNull();
    expect(doc().querySelector('#detail')!.textContent).toContain('Razón <img src=x onerror=alert(1)>');
  });

  it('saves a label when a verdict button is pressed and updates the metrics', async () => {
    await openArticle('muerte-anime');
    const before = doc().querySelector('.metric-card')!.textContent;
    const target = [...doc().querySelectorAll('.project')].find(p => p.querySelector('h3')!.textContent === 'Anime')!;
    const tentative = [...target.querySelectorAll('.seg button')].find(b => b.textContent === 'Tentativo') as HTMLButtonElement;
    tentative.click();

    await waitFor(() => doc().getElementById('save-state')!.textContent!.includes('Guardado'), 'the save confirmation');
    const saved = YAML.parse(await fs.readFile(path.join(dir, 'labels.yaml'), 'utf-8'));
    expect(saved.cases.find((c: any) => c.article === 'muerte-anime').projects['Projects/Anime'].verdict).toBe('tentative');
    expect(doc().querySelector('.metric-card')!.textContent).not.toBe(before);
  });

  it('filters to articles where a model disagrees with the labels', async () => {
    const filter = [...doc().querySelectorAll('.filters button')].find(b => b.getAttribute('data-filter') === 'disagree') as HTMLButtonElement;
    filter.click();
    await waitFor(() => filter.getAttribute('aria-checked') === 'true', 'the filter to apply');
    const ids = [...doc().querySelectorAll('#article-list .chip.source')].map(e => e.textContent);
    expect(ids).toContain('futbol-liga'); // model says tentative, label says irrelevant
    expect(ids).toContain('pan-masa-madre'); // label says actionable, the model never evaluated the pair
  });
});
