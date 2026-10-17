import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Audit F-07 / invariant I5: accepting the same tentative evaluation twice at once
// (double click, retry) must create one suggestion and one callout.
describe('Concurrent accept of a tentative evaluation', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let db: any;
  let schema: any;
  let vaultPath: string;
  let projectId: string;
  let contentId: string;
  let snapshotId: string;

  async function createTentativeEvaluation(seq: number): Promise<string> {
    const [evaluation] = await db.insert(schema.evaluations).values({
      contentId, projectSnapshotId: snapshotId, verdict: 'tentative',
      confidenceScore: 0.5, triageReasoning: 'Relación tangencial', consumptionSeq: seq,
    }).returning();
    return evaluation.id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-tentative-'));
    await fs.mkdir(path.join(vaultPath, 'Projects', 'Ensayo'), { recursive: true });
    vi.stubEnv('VAULT_PATH', vaultPath);

    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');

    const [project] = await db.insert(schema.projects).values({ folderPath: 'Projects/Ensayo', title: 'Ensayo' }).returning();
    projectId = project.id;
    const [snapshot] = await db.insert(schema.projectSnapshots).values({ projectId, treeHash: 'h' }).returning();
    snapshotId = snapshot.id;
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/tangencial', title: 'Tangencial', ingestStatus: 'ready',
    }).returning();
    contentId = content.id;

    server = (await import('../src/api/server')).server;
    await server.ready();
  }, 120000);

  afterAll(async () => {
    await server?.close();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
  });

  const patch = (id: string, status: string) => server.inject({
    method: 'PATCH', url: `/api/suggestions/${id}`, payload: { status },
  });

  it('creates one suggestion and one callout for parallel accepts', async () => {
    const evaluationId = await createTentativeEvaluation(1);

    const responses = await Promise.all(Array.from({ length: 10 }, () => patch(evaluationId, 'accepted')));
    for (const res of responses) expect(res.statusCode).toBe(200);

    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.evaluationId, evaluationId));
    expect(rows).toHaveLength(1);

    const text = await fs.readFile(path.join(vaultPath, 'Projects', 'Ensayo', 'suggestions.md'), 'utf-8');
    expect(text.match(/\[!tip\] Sugerencia Aceptada/g)).toHaveLength(1);
  });

  it('the database refuses a second suggestion for the same evaluation', async () => {
    const evaluationId = await createTentativeEvaluation(3);
    const row = {
      evaluationId, projectId, contentId, actionType: 'other' as const, targetFile: 'ideas.md',
      observation: 'o', suggestedAction: 'a', status: 'accepted' as const,
    };
    await db.insert(schema.actionSuggestions).values(row);
    await expect(db.insert(schema.actionSuggestions).values(row)).rejects.toThrow();
  });

  it('rejects a conflicting resolution of an already resolved tentative item', async () => {
    const evaluationId = await createTentativeEvaluation(2);
    expect((await patch(evaluationId, 'discarded')).statusCode).toBe(200);
    expect((await patch(evaluationId, 'accepted')).statusCode).toBe(409);
  });
});
