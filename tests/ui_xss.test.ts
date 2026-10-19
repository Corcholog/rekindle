import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { JSDOM } from 'jsdom';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fakeEmbedding, installFakeAi, FakeAi } from './helpers/fakeAi';
import { ensureWebBuild, WEB_DIST } from './helpers/webBuild';

// The web UI shows page titles, summaries, notes and model output. This runs the real built UI
// (web/dist) in jsdom against the real API (Fastify inject) on a database full of hostile text,
// and checks that none of it becomes markup or runs.

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
    ensureWebBuild();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');
    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-xss-'));
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

  // Loads the built page (web/dist) in jsdom with the interface language and theme preselected
  async function openUi(lang: 'es' | 'en', theme: 'light' | 'dark') {
    const origin = 'http://127.0.0.1:3000';
    const html = (await fs.readFile(path.join(WEB_DIST, 'index.html'), 'utf-8')).replace(/<script[^>]*src="[^"]*app\.js"[^>]*><\/script>/, '');
    dom = new JSDOM(html, { runScripts: 'outside-only', url: `${origin}/`, pretendToBeVisual: true });
    dom.window.localStorage.setItem('rekindle.uiLanguage', lang);
    dom.window.localStorage.setItem('rekindle.theme', theme);
    const win = dom.window as any;
    // jsdom lacks these browser APIs used by the UI libraries
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    win.HTMLElement.prototype.scrollIntoView = function () {};
    win.fetch = async (url: string, init: any = {}) => {
      // Tests can slow the all-projects suggestion list to reproduce out-of-order responses
      if (win.__slowAllSuggestions && /\/api\/suggestions\?/.test(url) && !/projectId=/.test(url)) {
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      const res = await server.inject({
        method: init.method ?? 'GET', url: new URL(url, origin).pathname + new URL(url, origin).search,
        headers: { host: '127.0.0.1:3000', origin, ...(init.headers ?? {}) }, payload: init.body,
      });
      return new Response(res.body, { status: res.statusCode, headers: { 'content-type': res.headers['content-type'] ?? 'application/json' } });
    };
    // The bundle is a classic IIFE (web/vite.config.ts), so jsdom can run it
    dom.window.eval(await fs.readFile(path.join(WEB_DIST, 'assets', 'app.js'), 'utf-8'));
    await waitFor(() => !!doc().getElementById('tab-reading'), 'the app to render');
  }

  const go = (view: string) => (doc().getElementById(`tab-${view}`) as HTMLButtonElement).click();
  // React tracks input values itself: set them through the native setter and fire an input event
  const typeInto = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor((dom.window as any).HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  for (const [lang, theme] of [['es', 'light'], ['en', 'dark']] as const) {
    describe(`with the interface in ${lang}, ${theme} theme`, () => {
      beforeAll(() => openUi(lang, theme), 30000);
      afterAll(() => dom?.window.close());

      it('reading, suggestions, projects and synergies show the hostile text without running it', { timeout: 20000 }, async () => {
        go('reading');
        await waitFor(() => doc().querySelectorAll('.content-item-card').length === 2, 'the reading list');
        expect(injected()).toEqual(clean);
        expect(doc().body.textContent).toContain('<img src=x onerror="window.__xss=1">');

        // Each project's verdict opens in place to show the full reasoning, still as text
        const toggle = doc().querySelector('.evaluation-toggle') as HTMLButtonElement;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        toggle.click();
        await waitFor(() => toggle.getAttribute('aria-expanded') === 'true', 'the reasoning to open');
        expect(toggle.querySelector('.evaluation-reasoning')!.className).not.toContain('line-clamp');
        expect(toggle.querySelector('.evaluation-reasoning')!.textContent).toContain('<b>negrita</b>');
        expect(injected()).toEqual(clean);

        // "View suggestion" opens that project in Suggestions, on the right tab, and points at the card
        const viewLinks = [...doc().querySelectorAll('.view-suggestion')] as HTMLAnchorElement[];
        expect(viewLinks.length).toBe(2);
        const accepted = viewLinks.find(l => l.getAttribute('href')!.includes('tab=accepted'))!;
        expect(accepted.getAttribute('href')).toBe(`#suggestions?project=${projectB.id}&content=${readyContentId}&tab=accepted`);
        accepted.click();
        await waitFor(() => doc().getElementById('selected-project-title')?.textContent?.startsWith('Beta') ?? false, 'the linked project');
        await waitFor(() => !!doc().querySelector(`.suggestion-card.focused[data-content-id="${readyContentId}"]`), 'the linked card');
        expect(doc().getElementById('tab-status-accepted')!.getAttribute('data-state')).toBe('active');
        expect(injected()).toEqual(clean);

        go('suggestions');
        await waitFor(() => doc().querySelectorAll('.suggestion-card').length >= 1, 'the suggestions');
        await waitFor(() => doc().querySelectorAll('.synergy-card').length === 1, 'the synergies');
        await waitFor(() => doc().querySelectorAll('.project-item').length === 3, 'the project list');
        expect(injected()).toEqual(clean);
        expect(doc().body.textContent).toContain('Alfa <img src=x');
        // The javascript: URI never becomes a link
        const links = [...doc().querySelectorAll('.suggestion-card a')].map(a => a.getAttribute('href'));
        expect(links.every(href => /^https?:/.test(href!))).toBe(true);
      });

      it('a link to a project is not overwritten by a slower list of all projects', { timeout: 15000 }, async () => {
        go('reading');
        await waitFor(() => doc().querySelectorAll('.content-item-card').length === 2, 'the reading list');
        (dom.window as any).__slowAllSuggestions = true;
        // The first list loaded (all projects, active tab) holds only Alfa's card; the link asks for Beta's accepted one
        dom.window.location.hash = `#suggestions?project=${projectB.id}&content=${readyContentId}&tab=accepted`;
        await waitFor(() => !!doc().querySelector('.suggestion-card.focused'), 'the linked card');
        await new Promise(resolve => setTimeout(resolve, 600)); // the slow response has arrived by now
        (dom.window as any).__slowAllSuggestions = false;
        const cards = [...doc().querySelectorAll('.suggestion-card')];
        expect(cards.length).toBe(1);
        expect(cards[0].textContent).toContain('Beta');
      });

      it('the content detail dialog shows the summary and reasoning as text', { timeout: 15000 }, async () => {
        go('reading');
        await waitFor(() => !!doc().querySelector(`.btn-detail[data-content-id="${readyContentId}"]`), 'the reading list');
        (doc().querySelector(`.btn-detail[data-content-id="${readyContentId}"]`) as HTMLButtonElement).click();
        await waitFor(() => (doc().getElementById('modal-content-body')?.textContent ?? '').includes('negrita'), 'the content dialog');
        expect(injected()).toEqual(clean);
        // javascript: source shown as text, never as an href
        expect([...doc().querySelectorAll('.modal-uri-link')].map(a => a.getAttribute('href'))).toEqual([null]);
        doc().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      it('the Consultant and the synergy bridge render hostile model output as text', { timeout: 20000 }, async () => {
        fake.answerNext({
          diagnosis: `Según [C1] ${XSS}`, projectViability: XSS,
          matchedContents: [{ refId: 'C1', whyItConnects: XSS }], matchedNotes: [{ refId: 'N1', whyItConnects: XSS }],
        });
        go('consultant');
        await waitFor(() => !!doc().getElementById('consultant-query-input'), 'the Consultant');
        typeInto(doc().getElementById('consultant-query-input') as HTMLInputElement, 'faros');
        doc().getElementById('consultant-query-form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
        await waitFor(() => doc().querySelectorAll('.consultant-match-card').length === 2, 'the Consultant answer');
        expect(injected()).toEqual(clean);
        expect(doc().querySelectorAll('.consultant-match-card a.source-link')).toHaveLength(0);
        expect(doc().querySelector('.consult-ref-badge')?.getAttribute('data-ref')).toBe('C1');

        fake.answerNext({ bridgeTitle: XSS, overview: XSS, sharedProblems: [XSS], mutualBenefits: [XSS], markdownContent: XSS });
        go('suggestions');
        await waitFor(() => !!doc().querySelector('[data-proj-a]'), 'the synergies');
        (doc().querySelector('[data-proj-a]') as HTMLButtonElement).click();
        await waitFor(() => (doc().getElementById('synergy-modal-body')?.textContent ?? '').includes('negrita'), 'the synergy bridge');
        expect(injected()).toEqual(clean);
        expect([projectA.id, projectB.id]).toContain((doc().querySelector('[data-proj-a]') as HTMLElement).dataset.projA);
        doc().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      it('renders in the chosen language and theme', async () => {
        expect(doc().documentElement.lang).toBe(lang);
        expect(doc().documentElement.classList.contains('dark')).toBe(theme === 'dark');
        expect(doc().getElementById('tab-suggestions')!.textContent).toContain(lang === 'en' ? 'Suggestions' : 'Sugerencias');
        if (lang === 'en') {
          go('settings');
          await waitFor(() => !!doc().getElementById('vault-path-input'), 'the settings');
          go('suggestions');
          await waitFor(() => doc().querySelectorAll('.suggestion-card').length >= 1, 'the suggestions');
          // Rendered views are English too (the seeded data is language-neutral)
          const text = doc().body.textContent!.replace(/\s+/g, ' ');
          for (const word of ['Descartar', 'Aceptar', 'Fuente:', 'Ver ficha', 'Cargando', 'sugerencias']) {
            expect(text, word).not.toContain(word);
          }
          expect(text).toContain('Discard');
        }
      });
    });
  }
});
