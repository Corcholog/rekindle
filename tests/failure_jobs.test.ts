import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { installFakeAi, fakeEmbedding, FakeAi } from './helpers/fakeAi';

// Audit failure scenario 3: a queued job runs twice, concurrently, or is interrupted.

const actionable = {
  verdict: 'actionable', confidenceScore: 0.9, triageReasoning: 'Aporta un caso concreto.',
  action: { actionType: 'evidence_citation', observation: 'Caso útil.', suggestedAction: 'Citarlo en el capítulo dos.', targetFile: null },
};

describe('Failure scenario 3: duplicate, concurrent and interrupted jobs', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let pool: any;
  let schema: any;
  let drizzle: any;
  let boss: any;
  let fake: FakeAi;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    pool = dbModule.pool;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
    drizzle = await import('drizzle-orm');
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    fake = installFakeAi(sharedAiProvider);
  }, 180000);

  afterAll(async () => {
    if (boss) await boss.stop({ graceful: false });
    await pool.end();
    await container?.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function seed(topic: string) {
    const vector = fakeEmbedding(topic);
    const [project] = await db.insert(schema.projects).values({ folderPath: `Projects/${topic}`, title: topic }).returning();
    const [snapshot] = await db.insert(schema.projectSnapshots).values({
      projectId: project.id, treeHash: topic, thesisText: `Tesis ${topic}`, embedding: vector, embeddingModel: 'bge-m3',
    }).returning();
    const [content] = await db.insert(schema.contents).values({
      uri: `https://example.com/${encodeURIComponent(topic)}`, summary: `Resumen ${topic}`, ingestStatus: 'ready',
      embedding: vector, embeddingModel: 'bge-m3',
    }).returning();
    return { project, snapshot, content };
  }

  async function rowsFor(contentId: string) {
    const { eq } = drizzle;
    return {
      evaluations: await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, contentId)),
      suggestions: await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, contentId)),
    };
  }

  it('two concurrent runs of the same evaluation store one evaluation and one suggestion', async () => {
    const { content } = await seed('relojería mecánica escapes volantes');
    // Both runs pass the "already evaluated?" check before either writes
    const slowAnswer = () => new Promise(resolve => setTimeout(() => resolve(actionable), 300));
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    const answerSpy = vi.spyOn(sharedAiProvider, 'evaluateContent').mockImplementation(async () => ({ data: await slowAnswer(), model: 'fake:slow' } as any));

    const { evaluateContentMatch } = await import('../src/evaluator');
    const [a, b] = await Promise.all([evaluateContentMatch(content.id), evaluateContentMatch(content.id)]);
    answerSpy.mockRestore();

    const rows = await rowsFor(content.id);
    expect(rows.evaluations).toHaveLength(1);
    expect(rows.suggestions).toHaveLength(1);
    expect([a.evaluated, b.evaluated].sort()).toEqual([0, 1]);
    expect(a.alreadyEvaluated + b.alreadyEvaluated).toBe(1);
    expect(a.failures + b.failures).toBe(0);
  });

  it('a job delivered twice evaluates once and makes no second LLM call', async () => {
    const { content } = await seed('apicultura colmenas abejas miel');
    fake.answerNext(actionable);
    const { evaluateContentMatch } = await import('../src/evaluator');
    const callsBefore = fake.calls.length;

    await evaluateContentMatch(content.id);
    const second = await evaluateContentMatch(content.id);

    expect(fake.calls.length - callsBefore).toBe(1);
    expect(second).toMatchObject({ evaluated: 0, alreadyEvaluated: 1, failures: 0 });
    const rows = await rowsFor(content.id);
    expect(rows.evaluations).toHaveLength(1);
    expect(rows.suggestions).toHaveLength(1);
  });

  it('an evaluation interrupted before its suggestion is written leaves nothing, so the retry completes it', async () => {
    const { content } = await seed('cartografía mapas proyecciones náuticas');
    // The suggestion insert fails once, as if the process died between the two writes
    await pool.query(`
      CREATE FUNCTION fail_suggestion_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated crash'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_suggestion_insert BEFORE INSERT ON action_suggestions
      FOR EACH ROW EXECUTE FUNCTION fail_suggestion_insert();`);
    fake.answerNext(actionable, actionable);
    const { evaluateContentMatch } = await import('../src/evaluator');

    const interrupted = await evaluateContentMatch(content.id);
    expect(interrupted.failures).toBe(1);
    expect(await rowsFor(content.id)).toEqual({ evaluations: [], suggestions: [] });

    await pool.query('DROP TRIGGER fail_suggestion_insert ON action_suggestions; DROP FUNCTION fail_suggestion_insert();');
    const retried = await evaluateContentMatch(content.id);
    expect(retried).toMatchObject({ evaluated: 1, suggestions: 1, failures: 0 });
    const rows = await rowsFor(content.id);
    expect(rows.evaluations).toHaveLength(1);
    expect(rows.suggestions).toHaveLength(1);
    expect(rows.suggestions[0].evaluationId).toBe(rows.evaluations[0].id);
  });

  it('an ingestion interrupted by a failed embedding is retried and enqueues one evaluation', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      `<html><head><title>Telares</title></head><body><article><p>${'Historia de los telares mecánicos. '.repeat(30)}</p></article></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    ));
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    let embedCalls = 0;
    const realOverrides = { embed: async (text: string) => fakeEmbedding(text) };
    sharedAiProvider.setOverrides({
      ...realOverrides,
      evaluate: async (_s: string, user: string, zodSchema: any) => ({ data: zodSchema.parse({ summary: `Resumen: ${user.slice(0, 40)}` }), model: 'fake:scripted' }),
      embed: async (text: string) => {
        if (++embedCalls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return fakeEmbedding(text);
      },
    });

    const queue = await import('../src/queue/index');
    boss = queue.boss;
    await queue.startQueue();
    await (await import('../src/workers/ingestionWorker')).setupIngestionWorker();

    const [content] = await db.insert(schema.contents).values({ uri: 'https://example.com/telares', ingestStatus: 'pending' }).returning();
    const jobId = await boss.send('ingest_url', { contentId: content.id, url: 'https://example.com/telares', traceId: crypto.randomUUID() }, { retryLimit: 2, retryDelay: 1 });

    const deadline = Date.now() + 60000;
    let job: any;
    while (Date.now() < deadline) {
      job = await boss.getJobById('ingest_url', jobId);
      if (job?.state === 'completed' || job?.state === 'failed') break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(job.state).toBe('completed');
    expect(job.retryCount).toBe(1);

    const { eq } = drizzle;
    const [stored] = await db.select().from(schema.contents).where(eq(schema.contents.id, content.id));
    expect(stored).toMatchObject({ ingestStatus: 'ready', ingestStatusReason: null, embeddingModel: 'bge-m3' });
    const evaluateJobs = await pool.query(`SELECT id FROM pgboss.job WHERE name = 'evaluate_content' AND data->>'contentId' = $1`, [content.id]);
    expect(evaluateJobs.rowCount).toBe(1);
  }, 90000);
});
