import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { installFakeAi, FakeAi } from './fakeAi';

// The path a new user follows from the README, offline: the demo vault is indexed, a clipped
// article is ingested and evaluated, a pending suggestion appears, and accepting it writes one
// callout into the matching project's suggestions.md. A control article that matches nothing
// produces no suggestion. Models are replaced by deterministic fakes; the page is stubbed.
// Each language runs in its own test file, because src/db binds its pool on first import.

export interface DemoCase {
  language: 'es' | 'en';
  vaultDir: string;
  projectFolders: string[];
  lighthouseFolder: string;
  lighthouseTitle: string;
  nestedNote: string;
  matchUrl: string;
  matchHtml: string;
  matchWord: string;
  matchSummary: string;
  controlUrl: string;
  controlHtml: string;
  controlSummary: string;
  targetNote: string;
  action: { observation: string; suggestedAction: string; reasoning: string };
  calloutTitle: string;
  /** The line the triage prompt must carry for this output language. */
  answerLine: string;
  /** Words of the summary prompt that name the summary language. */
  summaryLanguageLine: string;
}

export function defineFirstSuggestionSuite(c: DemoCase) {
  // One scripted responder for every call: leftover queue entries are harmless to later tests
  const respond = (call: { kind: string; user: string }) => {
    if (call.kind === 'summary') {
      return { summary: call.user.includes(c.matchWord) ? c.matchSummary : c.controlSummary };
    }
    return call.user.includes(c.lighthouseTitle)
      ? {
        verdict: 'actionable', confidenceScore: 0.9, connection: c.action.reasoning,
        action: { actionType: 'evidence_citation', observation: c.action.observation, suggestedAction: c.action.suggestedAction, targetFile: c.targetNote },
      }
      : { verdict: 'irrelevant', confidenceScore: 0.2, connection: '-', action: null };
  };

  describe(`From a clean install to a first accepted suggestion (${c.language})`, () => {
    let container: StartedPostgreSqlContainer;
    let vault: string;
    let server: any;
    let boss: any;
    let db: any;
    let schema: any;
    let fake: FakeAi;

    const waitFor = async <T>(check: () => Promise<T | undefined | false>, what: string): Promise<T> => {
      for (let i = 0; i < 120; i++) {
        const value = await check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Timed out waiting for ${what}`);
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
      vault = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-first-'));
      await fs.cp(c.vaultDir, vault, { recursive: true });
      vi.stubEnv('DATABASE_URL', container.getConnectionUri());
      vi.stubEnv('EMBED_MODEL', 'bge-m3');
      vi.stubEnv('VAULT_PATH', vault);
      vi.stubEnv('LANGUAGE', c.language);

      const dbModule = await import('../../src/db/index');
      db = dbModule.db;
      const { migrate } = await import('drizzle-orm/node-postgres/migrator');
      await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
      await migrate(db, { migrationsFolder: './drizzle' });
      schema = await import('../../src/db/schema');
      const { sharedAiProvider } = await import('../../src/ai/aiProvider');
      fake = installFakeAi(sharedAiProvider);

      const queue = await import('../../src/queue/index');
      boss = queue.boss;
      await queue.startQueue();
      await (await import('../../src/workers/ingestionWorker')).setupIngestionWorker();
      await (await import('../../src/workers/evaluationWorker')).setupEvaluationWorker();
      server = (await import('../../src/api/server')).server;
      await server.ready();

      await (await import('../../src/vault/reconciler')).reconcileAllProjects(vault, true);

      global.fetch = vi.fn(async (url: any) => ({
        ok: true,
        text: async () => (String(url) === c.matchUrl ? c.matchHtml : c.controlHtml),
      })) as any;
    }, 300000);

    afterAll(async () => {
      await server?.close();
      if (boss) await boss.stop();
      const { pool } = await import('../../src/db/index');
      await pool.end();
      await container?.stop();
      await fs.rm(vault, { recursive: true, force: true });
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    const ingest = async (url: string) => {
      const res = await server.inject({ method: 'POST', url: '/api/ingest', payload: { url } });
      expect(res.statusCode).toBe(202);
      return res.json().contentId as string;
    };
    const ready = async (contentId: string) => {
      const { eq } = await import('drizzle-orm');
      return waitFor(async () => {
        const [row] = await db.select().from(schema.contents).where(eq(schema.contents.id, contentId));
        if (row?.ingestStatus === 'failed') throw new Error(`ingest failed: ${row.ingestStatusReason}`);
        return row?.ingestStatus === 'ready' ? row : false;
      }, 'the article to be ready');
    };

    it('indexes every demo project with its notes', async () => {
      const { eq } = await import('drizzle-orm');
      const projects = await db.select().from(schema.projects);
      expect(projects.map((p: any) => p.folderPath).sort()).toEqual(c.projectFolders.map(f => `Projects/${f}`).sort());
      const lighthouse = projects.find((p: any) => p.folderPath.endsWith(c.lighthouseFolder));
      expect(lighthouse.title).toBe(c.lighthouseTitle);
      const [snapshot] = await db.select().from(schema.projectSnapshots).where(eq(schema.projectSnapshots.projectId, lighthouse.id));
      const notes = await db.select().from(schema.projectNoteSnapshots).where(eq(schema.projectNoteSnapshots.projectSnapshotId, snapshot.id));
      expect(notes.map((n: any) => n.notePath)).toContain(c.nestedNote);
      expect(notes).toHaveLength(5);
    });

    it('turns a matching article into a pending suggestion; accepting it writes one callout', { timeout: 120000 }, async () => {
      fake.answerNext(...Array(6).fill(respond));
      fake.calls.length = 0;
      const contentId = await ingest(c.matchUrl);
      await ready(contentId);

      const { eq } = await import('drizzle-orm');
      const suggestion = await waitFor(async () => {
        const [row] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, contentId));
        return row;
      }, 'the first suggestion');
      expect(suggestion.status).toBe('pending');
      expect(suggestion.targetFile).toBe(c.targetNote);

      // The prompts asked for the configured languages
      expect(fake.calls.find(call => call.kind === 'summary')!.system).toContain(c.summaryLanguageLine);
      expect(fake.calls.find(call => call.kind === 'triage')!.system).toContain(c.answerLine);

      // I1: nothing in the vault changes until the owner accepts
      const suggestionsFile = path.join(vault, 'Projects', c.lighthouseFolder, 'suggestions.md');
      await expect(fs.access(suggestionsFile)).rejects.toThrow();

      const accepted = await server.inject({ method: 'PATCH', url: `/api/suggestions/${suggestion.id}`, payload: { status: 'accepted' } });
      expect(accepted.statusCode).toBe(200);

      const written = await fs.readFile(suggestionsFile, 'utf-8');
      expect(written.match(/> \[!/g)).toHaveLength(1);
      expect(written).toContain(`> [!tip] ${c.calloutTitle}:`);
      expect(written).toContain(c.action.suggestedAction);
      expect(written).toContain(`%% rekindle:${suggestion.id} %%`);
      for (const other of c.projectFolders.filter(f => f !== c.lighthouseFolder)) {
        await expect(fs.access(path.join(vault, 'Projects', other, 'suggestions.md'))).rejects.toThrow();
      }
    });

    it('creates no suggestion for an article that matches no project', { timeout: 120000 }, async () => {
      fake.answerNext(...Array(6).fill(respond));
      const contentId = await ingest(c.controlUrl);
      await ready(contentId);
      const { eq } = await import('drizzle-orm');
      // Give the evaluation job time to run, then check nothing was produced
      await new Promise(resolve => setTimeout(resolve, 3000));
      expect(await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, contentId))).toHaveLength(0);
      expect(await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, contentId))).toHaveLength(0);
    });
  });
}
