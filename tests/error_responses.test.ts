import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Audit F-26: internal error text (provider errors, hosts, credentials) must not reach clients.
describe('500 responses do not leak internal error messages', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let db: any;
  let schema: any;
  let suggestionId: string;
  let projectId: string;
  const secret = 'connect ECONNREFUSED 10.1.2.3:5432 password=hunter2';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');

    const [project] = await db.insert(schema.projects).values({ folderPath: 'Projects/P', title: 'P' }).returning();
    projectId = project.id;
    const [snapshot] = await db.insert(schema.projectSnapshots).values({ projectId, treeHash: 'h', notesContent: 'Notas' }).returning();
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/x', title: 'X', summary: 'Resumen', ingestStatus: 'ready',
    }).returning();
    const [evaluation] = await db.insert(schema.evaluations).values({
      contentId: content.id, projectSnapshotId: snapshot.id, verdict: 'actionable', consumptionSeq: 1,
    }).returning();
    const [suggestion] = await db.insert(schema.actionSuggestions).values({
      evaluationId: evaluation.id, projectId, contentId: content.id, actionType: 'other',
      targetFile: 'ideas.md', observation: 'o', suggestedAction: 'a', status: 'pending',
    }).returning();
    suggestionId = suggestion.id;

    const { sharedAiProvider } = await import('../src/ai/OllamaProvider');
    vi.spyOn(sharedAiProvider, 'evaluateContent').mockRejectedValue(new Error(secret));

    server = (await import('../src/api/server')).server;
    await server.ready();
  }, 120000);

  afterAll(async () => {
    await server?.close();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.restoreAllMocks();
  });

  const expectGeneric500 = (res: any) => {
    expect(res.statusCode).toBe(500);
    expect(res.payload).not.toContain('hunter2');
    expect(res.payload).not.toContain('ECONNREFUSED');
  };

  it('Consultor', async () => {
    expectGeneric500(await server.inject({ method: 'POST', url: '/api/library/consult', payload: { query: 'agentes' } }));
  });

  it('single re-evaluation', async () => {
    expectGeneric500(await server.inject({ method: 'POST', url: `/api/suggestions/${suggestionId}/reevaluate` }));
  });
});
