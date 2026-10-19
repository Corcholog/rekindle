import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Discarding can carry one of a fixed set of reasons. `pnpm usertest:stats` counts them, so they
// must be stored only for discards and only when valid.
describe('Discard reasons', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let db: any;
  let schema: any;
  let projectId: string;
  let contentId: string;
  let snapshotId: string;
  let seq = 0;

  const newPending = async () => {
    const [evaluation] = await db.insert(schema.evaluations).values({
      contentId, projectSnapshotId: snapshotId, verdict: 'actionable', confidenceScore: 0.8, triageReasoning: 'r', consumptionSeq: ++seq,
    }).returning();
    const [suggestion] = await db.insert(schema.actionSuggestions).values({
      evaluationId: evaluation.id, projectId, contentId, actionType: 'other', targetFile: 'ideas.md', observation: 'o', suggestedAction: 'a',
    }).returning();
    return suggestion.id as string;
  };
  const patch = (id: string, payload: object) => server.inject({ method: 'PATCH', url: `/api/suggestions/${id}`, payload });
  const stored = async (id: string) => {
    const { eq } = await import('drizzle-orm');
    return (await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.id, id)))[0];
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('VAULT_PATH', '');
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
    const [project] = await db.insert(schema.projects).values({ folderPath: 'Projects/P', title: 'P' }).returning();
    projectId = project.id;
    snapshotId = (await db.insert(schema.projectSnapshots).values({ projectId, treeHash: 'h' }).returning())[0].id;
    contentId = (await db.insert(schema.contents).values({ uri: 'https://example.com/a', ingestStatus: 'ready' }).returning())[0].id;
    server = (await import('../src/api/server')).server;
    await server.ready();
  }, 120000);

  afterAll(async () => {
    await server?.close();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it('stores the reason with a discard', async () => {
    const id = await newPending();
    expect((await patch(id, { status: 'discarded', discardReason: 'wrong_note', userFeedback: 'otra nota' })).statusCode).toBe(200);
    expect(await stored(id)).toMatchObject({ status: 'discarded', discardReason: 'wrong_note', userFeedback: 'otra nota' });
  });

  it('keeps discarding without a reason working', async () => {
    const id = await newPending();
    expect((await patch(id, { status: 'discarded' })).statusCode).toBe(200);
    expect((await stored(id)).discardReason).toBeNull();
  });

  it('rejects unknown reasons and reasons on an accept, leaving the suggestion pending', async () => {
    const id = await newPending();
    expect((await patch(id, { status: 'discarded', discardReason: 'aburrido' })).statusCode).toBe(400);
    expect((await patch(id, { status: 'accepted', discardReason: 'other' })).statusCode).toBe(400);
    expect((await stored(id)).status).toBe('pending');
  });
  // The UI side (the reasons offered and their labels) is checked in tests/ui_i18n.test.ts
});
