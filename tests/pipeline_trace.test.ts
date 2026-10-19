import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

// Phase 4: one trace follows a clipped URL through ingestion, retrieval and triage to its
// suggestion. Runs the real route, queue and workers with stubbed model calls and fetch.

const SENTINEL = 'SENTINEL-9c1e';
const VECTOR = Array.from({ length: 1024 }, (_, i) => ((i * 7) % 11) / 11);
const ARTICLE_URL = 'https://articulo.example.org/ensayo';

describe('Pipeline trace', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let db: any;
  let boss: any;
  let schema: any;
  let drizzle: any;
  let project: any;
  let snapshot: any;
  let note: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');

    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
    drizzle = await import('drizzle-orm');

    // A project whose note matches the article exactly (distance 0)
    [project] = await db.insert(schema.projects).values({ folderPath: 'Projects/Ensayo', title: `Ensayo ${SENTINEL}` }).returning();
    [snapshot] = await db.insert(schema.projectSnapshots).values({
      projectId: project.id, treeHash: 'h1', thesisText: `Tesis ${SENTINEL}`, notesContent: `Notas privadas ${SENTINEL}`,
      embedding: VECTOR, embeddingModel: 'bge-m3',
    }).returning();
    [note] = await db.insert(schema.projectNoteSnapshots).values({
      projectSnapshotId: snapshot.id, projectId: project.id, notePath: `borrador-${SENTINEL}.md`, noteTitle: `Borrador ${SENTINEL}`,
      contentSnippet: `Extracto ${SENTINEL}`, embedding: VECTOR, embeddingModel: 'bge-m3',
    }).returning();

    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    sharedAiProvider.setOverrides({
      embed: async () => VECTOR,
      evaluate: async (_system: string, _user: string, zodSchema: any) => {
        const isSummary = 'summary' in (zodSchema.shape ?? {});
        const data = isSummary
          ? { summary: `Resumen ${SENTINEL}` }
          : {
            verdict: 'actionable', confidenceScore: 0.9, triageReasoning: `Razonamiento ${SENTINEL}`,
            action: { actionType: 'evidence_citation', observation: `Observación ${SENTINEL}`, suggestedAction: `Citar ${SENTINEL}`, targetFile: null },
          };
        return {
          data, model: 'deepseek:deepseek-flash', latencyMs: 20, usage: { promptTokens: 1000, completionTokens: 100 },
          attempts: [{ provider: 'deepseek', model: 'deepseek-flash', ok: true, latencyMs: 20, usage: { promptTokens: 1000, completionTokens: 100 } }],
        };
      },
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      `<html><head><title>Artículo</title></head><body><article><p>Texto del artículo ${SENTINEL}. ${'Contenido largo. '.repeat(40)}</p></article></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    ));

    const queue = await import('../src/queue/index');
    boss = queue.boss;
    await queue.startQueue();
    await (await import('../src/workers/ingestionWorker')).setupIngestionWorker();
    await (await import('../src/workers/evaluationWorker')).setupEvaluationWorker();

    server = Fastify().withTypeProvider<ZodTypeProvider>();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.register((await import('../src/api/routes/ingest')).default);
    await server.ready();
  }, 180000);

  afterAll(async () => {
    if (boss) await boss.stop({ graceful: false });
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 60000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Timed out waiting for the pipeline');
  }

  it('links the suggestion to its content, retrieval step, stages and LLM calls through one trace', async () => {
    const response = await server.inject({ method: 'POST', url: '/api/ingest', payload: { url: ARTICLE_URL } });
    expect(response.statusCode).toBe(202);
    const { contentId } = response.json();
    const { eq } = drizzle;

    const suggestion = await waitFor(async () => {
      const [row] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, contentId));
      return row;
    });
    // The job event is written right after the suggestion
    await waitFor(async () => {
      const [row] = await db.select().from(schema.pipelineEvents).where(eq(schema.pipelineEvents.stage, 'evaluate_job'));
      return row;
    });

    const [content] = await db.select().from(schema.contents).where(eq(schema.contents.id, contentId));
    const traceId = content.traceId;
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);

    const [evaluation] = await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, suggestion.evaluationId));
    expect(evaluation.traceId).toBe(traceId);

    const events = await db.select().from(schema.pipelineEvents).where(eq(schema.pipelineEvents.traceId, traceId));
    expect(events.map((e: any) => e.stage).sort()).toEqual(
      ['embed', 'evaluate', 'evaluate_job', 'extract', 'fetch', 'ingest_job', 'retrieve', 'summarize'].sort(),
    );
    expect(events.every((e: any) => e.ok && e.contentId === contentId && e.durationMs >= 0)).toBe(true);
    expect(events.find((e: any) => e.stage === 'ingest_job').attempt).toBe(1);

    const retrieve = events.find((e: any) => e.stage === 'retrieve');
    expect(evaluation.retrievalEventId).toBe(retrieve.id);
    expect(retrieve.attrs).toMatchObject({ threshold: 0.6, limit: 3, withinThreshold: 1, returned: 1 });
    expect(retrieve.attrs.candidates).toEqual([{
      rank: 1, projectId: project.id, snapshotId: snapshot.id, noteSnapshotId: note.id, level: 'note', distance: 0,
    }]);

    const evaluate = events.find((e: any) => e.stage === 'evaluate');
    expect(evaluate.snapshotId).toBe(snapshot.id);
    expect(evaluate.attrs).toMatchObject({ rank: 1, verdict: 'actionable', suggestionId: suggestion.id, evaluationId: evaluation.id });
    expect(events.find((e: any) => e.stage === 'evaluate_job').attrs).toMatchObject({ origin: 'ingest', candidates: 1, evaluated: 1, suggestions: 1, failures: 0 });

    const telemetry = await db.select().from(schema.llmTelemetry).where(eq(schema.llmTelemetry.traceId, traceId));
    expect(telemetry.map((t: any) => t.component).sort()).toEqual(['summary', 'triage']);
    expect(telemetry.find((t: any) => t.component === 'triage')).toMatchObject({ suggestionId: suggestion.id, snapshotId: snapshot.id, costUsd: expect.any(Number) });

    // Nothing private in the observability tables
    expect(JSON.stringify([events, telemetry])).not.toContain(SENTINEL);
    expect(JSON.stringify([events, telemetry])).not.toContain(ARTICLE_URL);
  }, 90000);
});
