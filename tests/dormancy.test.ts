import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { idleDays, isDormant } from '../src/vault/dormancy';
import { installFakeAi, FakeAi } from './helpers/fakeAi';

// Rekindle exists for projects left alone for weeks. The age of a project's own notes is taken
// from their modification times; Rekindle's own files never reset it.

const DAY = 24 * 60 * 60 * 1000;

describe('idle days', () => {
  it('counts whole days, never negative, and marks 14 or more as dormant', () => {
    const now = Date.UTC(2026, 9, 19, 12);
    expect(idleDays(null, now)).toBeNull();
    expect(idleDays(new Date(now - 23.9 * DAY), now)).toBe(23);
    expect(idleDays(new Date(now + DAY), now)).toBe(0);
    expect([isDormant(null), isDormant(13), isDormant(14)]).toEqual([false, false, true]);
  });
});

describe('project dormancy end to end', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let db: any;
  let schema: any;
  let fake: FakeAi;
  let vault: string;
  const projectDir = () => path.join(vault, 'Projects', 'Faro');

  const age = async (file: string, days: number) => {
    const when = new Date(Date.now() - days * DAY);
    await fs.utimes(file, when, when);
  };
  const listed = async () => {
    const res = await server.inject({ method: 'GET', url: '/api/projects' });
    return res.json().projects.find((p: any) => p.folderPath === 'Projects/Faro');
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-dormancy-'));
    vi.stubEnv('VAULT_PATH', vault);
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    fake = installFakeAi(sharedAiProvider);
    server = (await import('../src/api/server')).server;
    await server.ready();

    await fs.mkdir(projectDir(), { recursive: true });
    await fs.writeFile(path.join(projectDir(), 'novela.md'), '# Faro\n\nUn farero y su hija aislados por los temporales en la costa.');
    await fs.writeFile(path.join(projectDir(), 'ideas.md'), '# Ideas\n\nNaufragios, niebla y la luz del faro.');
    await age(path.join(projectDir(), 'novela.md'), 40);
    await age(path.join(projectDir(), 'ideas.md'), 23);
    // Rekindle's own output is newer, and must not count as the owner working on the project
    await fs.writeFile(path.join(projectDir(), 'suggestions.md'), '> [!tip] x\n');
  }, 120000);

  afterAll(async () => {
    await server?.close();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    await fs.rm(vault, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('dates a project by its newest own note and reports it as dormant', async () => {
    const { reconcileProject } = await import('../src/vault/reconciler');
    await reconcileProject(projectDir(), vault, true);
    const project = await listed();
    expect(project).toMatchObject({ idleDays: 23, isDormant: true });
    expect(Math.abs(Date.parse(project.notesModifiedAt) - (Date.now() - 23 * DAY))).toBeLessThan(5000);
  });

  it('backfills snapshots taken before dormancy tracking', async () => {
    const { eq } = await import('drizzle-orm');
    await db.update(schema.projectSnapshots).set({ notesModifiedAt: null });
    expect((await listed()).idleDays).toBeNull();
    const { reconcileProject } = await import('../src/vault/reconciler');
    await reconcileProject(projectDir(), vault); // unchanged notes: no new snapshot, only the date
    const project = await listed();
    expect(project.idleDays).toBe(23);
    const snapshots = await db.select().from(schema.projectSnapshots).where(eq(schema.projectSnapshots.projectId, project.id));
    expect(snapshots).toHaveLength(1);
  });

  it('keeps on each evaluation how long the project had been idle', async () => {
    const [project] = await db.select().from(schema.projects);
    const { fakeEmbedding } = await import('./helpers/fakeAi');
    const [snapshot] = await db.select().from(schema.projectSnapshots);
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/faros', summary: 'Faros', embedding: fakeEmbedding('faro'), embeddingModel: 'bge-m3', ingestStatus: 'ready',
    }).returning();
    // Same vector as the project, so retrieval surely selects it
    await db.update(schema.projectSnapshots).set({ embedding: fakeEmbedding('faro') }).where((await import('drizzle-orm')).eq(schema.projectSnapshots.id, snapshot.id));
    fake.answerNext({
      verdict: 'actionable', confidenceScore: 0.9, connection: 'Sirve.',
      action: { actionType: 'evidence_citation', observation: 'o', suggestedAction: 'Citar.', targetFile: 'ideas.md' },
    });
    const { evaluateContentMatch } = await import('../src/evaluator');
    await evaluateContentMatch(content.id, project.id);

    const res = await server.inject({ method: 'GET', url: `/api/suggestions?status=pending&projectId=${project.id}` });
    expect(res.json().items[0]).toMatchObject({ projectIdleDays: 23 });

    // Editing the project afterwards does not rewrite history
    await fs.writeFile(path.join(projectDir(), 'ideas.md'), '# Ideas\n\nNaufragios, niebla, la luz del faro y un barco nuevo.');
    const { reconcileProject } = await import('../src/vault/reconciler');
    await reconcileProject(projectDir(), vault);
    expect((await listed()).idleDays).toBe(0);
    const again = await server.inject({ method: 'GET', url: `/api/suggestions?status=pending&projectId=${project.id}` });
    expect(again.json().items[0].projectIdleDays).toBe(23);
  });
});
