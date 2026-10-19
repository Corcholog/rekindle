import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { JSDOM } from 'jsdom';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fakeEmbedding, installFakeAi, FakeAi } from './helpers/fakeAi';

// The web UI renders page titles, summaries, notes and model output with innerHTML in 28 places.
// This runs the real index.html and app.js in jsdom against the real API (Fastify inject) on a
// database full of hostile text, and checks that none of it becomes markup or runs.

const XSS = '<img src=x onerror="window.__xss=1"><svg onload="window.__xss=1"></svg>"\'><b>negrita</b>';
const ATTR = '" onmouseover="window.__xss=1" x="';

describe('Web UI renders untrusted text as text', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let dom: JSDOM;
  let fake: FakeAi;
  let vaultPath: string;
  let projectA: any;
  let projectB: any;
  let readyContentId: string;

  const doc = () => dom.window.document;
  const waitFor = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const injected = () => ({
    flag: (dom.window as any).__xss,
    handlers: doc().querySelectorAll('[onerror],[onload],[onmouseover]').length,
    images: doc().querySelectorAll('img[src="x"]').length,
    bold: [...doc().querySelectorAll('b')].filter(b => b.textContent === 'negrita').length,
    jsLinks: [...doc().querySelectorAll('a[href]')].filter(a => /^\s*javascript:(?!void\(0\))/i.test(a.getAttribute('href')!)).length,
  });
  const clean = { flag: undefined, handlers: 0, images: 0, bold: 0, jsLinks: 0 };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');
    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-xss-'));
    vi.stubEnv('VAULT_PATH', vaultPath);

    const { pool, db } = await import('../src/db/index');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    fake = installFakeAi(sharedAiProvider);
    const schema = await import('../src/db/schema');

    // Two projects with an identical note, so the synergies view has a card
    const vector = fakeEmbedding('faro tormenta costa');
    const seedProject = async (name: string) => {
      await fs.mkdir(path.join(vaultPath, 'Projects', name), { recursive: true });
      const [project] = await db.insert(schema.projects).values({ folderPath: `Projects/${name}`, title: `${name} ${XSS}` }).returning();
      const [snapshot] = await db.insert(schema.projectSnapshots).values({
        projectId: project.id, treeHash: name, thesisText: XSS, notesContent: XSS, embedding: vector, embeddingModel: 'bge-m3',
      }).returning();
      await db.insert(schema.projectNoteSnapshots).values({
        projectSnapshotId: snapshot.id, projectId: project.id, notePath: `${XSS}.md`, noteTitle: `${XSS}${ATTR}`,
        contentSnippet: XSS, embedding: vector, embeddingModel: 'bge-m3',
      });
      return { project, snapshot };
    };
    const a = await seedProject('Alfa');
    const b = await seedProject('Beta');
    projectA = a.project;
    projectB = b.project;

    const [content] = await db.insert(schema.contents).values({
      uri: 'javascript:window.__xss=1//', title: `${XSS}${ATTR}`, channelOrDomain: XSS, summary: XSS, rawText: XSS,
      ingestStatus: 'ready', embedding: vector, embeddingModel: 'bge-m3',
    }).returning();
    readyContentId = content.id;
    await db.insert(schema.contents).values({
      uri: 'https://example.com/fallo', title: XSS, ingestStatus: 'failed', ingestStatusReason: XSS,
    });
    for (const [status, snapshot] of [['pending', a.snapshot], ['accepted', b.snapshot]] as const) {
      const [evaluation] = await db.insert(schema.evaluations).values({
        contentId: content.id, projectSnapshotId: snapshot.id, verdict: 'actionable', confidenceScore: 0.9,
        triageReasoning: XSS, consumptionSeq: 1,
      }).returning();
      await db.insert(schema.actionSuggestions).values({
        evaluationId: evaluation.id, projectId: snapshot.projectId, contentId: content.id, actionType: 'evidence_citation',
        targetFile: `${XSS}${ATTR}`, observation: XSS, suggestedAction: XSS, userFeedback: XSS, status,
        resolvedAt: status === 'accepted' ? new Date() : null,
      });
    }

    server = (await import('../src/api/server')).server;
    await server.ready();

  }, 180000);

  afterAll(async () => {
    await server?.close();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    await fs.rm(vaultPath, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  // Loads the real page in jsdom with the interface language preselected
  async function openUi(lang: 'es' | 'en') {
    const origin = 'http://127.0.0.1:3000';
    const html = (await fs.readFile('web/index.html', 'utf-8')).replace(/<script[^>]*src="(app|i18n)\.js"[^>]*><\/script>/g, '');
    dom = new JSDOM(html, { runScripts: 'outside-only', url: `${origin}/` });
    dom.window.localStorage.setItem('loom.uiLanguage', lang);
    // jsdom has no <dialog> methods
    const dialog = (dom.window as any).HTMLDialogElement.prototype;
    dialog.showModal = function () { this.open = true; };
    dialog.close = function () { this.open = false; };
    (dom.window as any).fetch = async (url: string, init: any = {}) => {
      const res = await server.inject({
        method: init.method ?? 'GET', url: new URL(url, origin).pathname + new URL(url, origin).search,
        headers: { host: '127.0.0.1:3000', origin, ...(init.headers ?? {}) }, payload: init.body,
      });
      return new Response(res.body, { status: res.statusCode, headers: { 'content-type': res.headers['content-type'] ?? 'application/json' } });
    };
    dom.window.eval(await fs.readFile('web/i18n.js', 'utf-8'));
    // app.js is an ES module with one export; jsdom runs classic scripts only
    dom.window.eval((await fs.readFile('web/app.js', 'utf-8')).replace(/^export /gm, ''));
    doc().dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  }

  for (const lang of ['es', 'en'] as const) {
    describe(`with the interface in ${lang}`, () => {
      beforeAll(() => openUi(lang), 30000);
      afterAll(() => dom?.window.close());

    it('inbox, triage, projects and synergies show the hostile text without running it', async () => {
      await waitFor(() => doc().querySelectorAll('.content-item-card').length === 2, 'the inbox');
      await waitFor(() => doc().querySelectorAll('.suggestion-card').length >= 1, 'the triage list');
      await waitFor(() => doc().querySelectorAll('.synergy-card').length === 1, 'the synergies');
      await waitFor(() => doc().querySelectorAll('.project-item').length === 3, 'the project list');

      expect(injected()).toEqual(clean);
      const text = doc().body.textContent!;
      expect(text).toContain('<img src=x onerror="window.__xss=1">');
      expect(text).toContain('Alfa <img src=x');
      // The javascript: URI is never a link target
      const contentLinks = [...doc().querySelectorAll('.suggestion-card a[target="_blank"]')].map(a => a.getAttribute('href'));
      expect(contentLinks.every(href => href === '#' || /^https?:/.test(href!))).toBe(true);
    });

    it('the content detail modal escapes the summary and reasoning', { timeout: 15000 }, async () => {
      (doc().querySelector(`.btn-detail[data-content-id="${readyContentId}"]`) as HTMLButtonElement).click();
      await waitFor(() => (doc().getElementById('modal-content-body')?.textContent ?? '').includes('negrita'), 'the content modal');
      expect(injected()).toEqual(clean);
      expect([...doc().querySelectorAll('.modal-uri-link')].map(a => a.getAttribute('href'))).toEqual(['#']);
    });

    it('the Consultor and the synergy bridge render hostile model output as text', { timeout: 20000 }, async () => {
      fake.answerNext({
        diagnosis: `Según [C1] ${XSS}`, projectViability: XSS,
        matchedContents: [{ refId: 'C1', whyItConnects: XSS }], matchedNotes: [{ refId: 'N1', whyItConnects: XSS }],
      });
      (doc().getElementById('consultant-query-input') as HTMLInputElement).value = 'faros';
      doc().getElementById('consultant-query-form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
      await waitFor(() => doc().querySelectorAll('.consultant-match-card').length === 2, 'the Consultor answer');
      expect(injected()).toEqual(clean);
      expect([...doc().querySelectorAll('.consultant-match-card a.source-link')].map(a => a.getAttribute('href'))).toEqual(['#']);
      expect(doc().querySelector('.consult-ref-badge')?.getAttribute('data-ref')).toBe('C1');

      fake.answerNext({ bridgeTitle: XSS, overview: XSS, sharedProblems: [XSS], mutualBenefits: [XSS], markdownContent: XSS });
      const explore = doc().querySelector(`[data-proj-a="${projectA.id}"][data-proj-b="${projectB.id}"], [data-proj-a="${projectB.id}"][data-proj-b="${projectA.id}"]`) as HTMLButtonElement;
      explore.click();
      await waitFor(() => (doc().getElementById('synergy-modal-body')?.textContent ?? '').includes('negrita'), 'the synergy bridge');
      expect(injected()).toEqual(clean);
    });

      it('renders the static text in the chosen language', () => {
        expect(doc().documentElement.lang).toBe(lang);
        expect(doc().getElementById('tab-triage')!.textContent).toContain(lang === 'en' ? 'Suggestions' : 'Sugerencias');
        if (lang === 'en') {
          // The rendered cards, lists and settings are English too (seeded data is language-neutral)
          const text = doc().body.textContent!.replace(/\s+/g, ' ');
          for (const word of ['Descartar', 'Aceptar', 'Fuente:', 'Ver ficha', 'Cargando', 'Proyecto(s)', 'sugerencias']) {
            expect(text, word).not.toContain(word);
          }
          expect(text).toContain('Discard');
        }
      });
    });
  }
});
