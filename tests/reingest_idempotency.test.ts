import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Audit F-08 / invariant I6: re-ingesting the same canonical URL never creates duplicate
// evaluations or suggestions. Only a failed ingest is retried.
describe('Re-ingesting a known URL', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let db: any;
  let schema: any;
  let sendSpy: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');

    const { boss } = await import('../src/queue');
    sendSpy = vi.spyOn(boss, 'send').mockResolvedValue('job-id');

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

  const ingest = (url: string) => server.inject({ method: 'POST', url: '/api/ingest', payload: { url } });
  const ingestJobs = () => sendSpy.mock.calls.filter((c: any[]) => c[0] === 'ingest_url').length;

  it('does not re-queue or bump consumption_seq for a URL already being processed or ready', async () => {
    sendSpy.mockClear();
    const first = await ingest('https://example.com/articulo?utm_source=x');
    expect(first.statusCode).toBe(202);
    const { contentId } = JSON.parse(first.payload);

    const again = await ingest('https://example.com/articulo');
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload).contentId).toBe(contentId);

    const { eq } = await import('drizzle-orm');
    await db.update(schema.contents).set({ ingestStatus: 'ready' }).where(eq(schema.contents.id, contentId));
    const third = await ingest('https://example.com/articulo#seccion');
    expect(third.statusCode).toBe(200);
    expect(JSON.parse(third.payload).status).toBe('ready');

    expect(ingestJobs()).toBe(1);
    const [row] = await db.select().from(schema.contents).where(eq(schema.contents.id, contentId));
    expect(row.consumptionSeq).toBe(1);
    expect(row.ingestStatus).toBe('ready');
  });

  it('retries an ingest that previously failed', async () => {
    sendSpy.mockClear();
    const first = await ingest('https://example.com/caido');
    const { contentId } = JSON.parse(first.payload);

    const { eq } = await import('drizzle-orm');
    await db.update(schema.contents)
      .set({ ingestStatus: 'failed', ingestStatusReason: 'Failed to fetch URL: 503' })
      .where(eq(schema.contents.id, contentId));

    const retry = await ingest('https://example.com/caido');
    expect(retry.statusCode).toBe(200);
    expect(ingestJobs()).toBe(2);
    const [row] = await db.select().from(schema.contents).where(eq(schema.contents.id, contentId));
    expect(row.ingestStatus).toBe('pending');
    expect(row.consumptionSeq).toBe(1);
  });

  it('evaluating the same content twice yields one evaluation and one suggestion', async () => {
    const { sharedAiProvider } = await import('../src/ai/OllamaProvider');
    const { evaluateContentMatch } = await import('../src/evaluator');
    const { eq } = await import('drizzle-orm');

    const vector = Array.from({ length: 1024 }, (_, i) => (i % 7) / 7);
    const [project] = await db.insert(schema.projects).values({ folderPath: 'Projects/Ensayo', title: 'Ensayo' }).returning();
    await db.insert(schema.projectSnapshots).values({
      projectId: project.id, treeHash: 'h', thesisText: 'Tesis', notesContent: 'Notas', embedding: vector,
    });
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/evaluado', title: 'Evaluado', summary: 'Resumen', ingestStatus: 'ready', embedding: vector,
    }).returning();

    const llm = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValue({
      data: {
        verdict: 'actionable', confidenceScore: 0.9, triageReasoning: 'Útil',
        action: { actionType: 'evidence_citation', observation: 'Obs', suggestedAction: 'Citar', targetFile: null },
      },
      model: 'fake',
    } as any);

    await evaluateContentMatch(content.id);
    await ingest('https://example.com/evaluado');
    await evaluateContentMatch(content.id);

    const evals = await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, content.id));
    const suggestions = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, content.id));
    expect(evals).toHaveLength(1);
    expect(suggestions).toHaveLength(1);
    expect(llm).toHaveBeenCalledTimes(1);
    llm.mockRestore();
  });
});
