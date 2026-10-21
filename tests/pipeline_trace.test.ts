import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Phase 4: one trace follows a clipped URL through ingestion, retrieval and triage to its
// suggestion. Runs the real route, queue and workers with stubbed model calls and fetch.
// Acceptance test for the roadmap: a suggestion is traceable to its content and retrieval step,
// and no prompt, note text, article text, model output or URL reaches the logs.

const SENTINEL = 'SENTINEL-9c1e';
const VECTOR = Array.from({ length: 1024 }, (_, i) => ((i * 7) % 11) / 11);
const ARTICLE_URL = 'https://articulo.example.org/ensayo';
const FAILING_URL = `https://articulo.example.org/otro-${SENTINEL}`;
const MISSING_URL = `https://articulo.example.org/no-existe-${SENTINEL}`;

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
  let failTriage = false;
  const logLines: string[] = [];
  let restoreLogs: () => void = () => {};

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');

    // Capture every log line of the run, at the most verbose level
    const { logger, setLogSink } = await import('../src/observability/logger');
    logger.level = 'debug';
    restoreLogs = setLogSink({ write: (line) => { logLines.push(line); } });

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
        const isStructure = 'headline' in (zodSchema.shape ?? {});
        if (!isSummary && failTriage) throw new Error(`El modelo respondió: ${SENTINEL}`);
        const data = isSummary
          ? { summary: `Resumen ${SENTINEL}` }
          : isStructure
          ? { connection: `Conexión ${SENTINEL}`, gap: null, headline: `Citar ${SENTINEL}`, steps: [{ note: null, where: null, change: `Citar ${SENTINEL}`, text: null }] }
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

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => String(input).includes('no-existe')
      ? new Response('no', { status: 404 })
      : new Response(
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
    restoreLogs();
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
    expect(telemetry.map((t: any) => t.component).sort()).toEqual(['structure', 'summary', 'triage']);
    expect(telemetry.find((t: any) => t.component === 'triage')).toMatchObject({ suggestionId: suggestion.id, snapshotId: snapshot.id, costUsd: expect.any(Number) });

    // Nothing private in the observability tables
    expect(JSON.stringify([events, telemetry])).not.toContain(SENTINEL);
    expect(JSON.stringify([events, telemetry])).not.toContain(ARTICLE_URL);
  }, 90000);

  it('renders the trace from a suggestion back to its retrieval step', async () => {
    const { eq } = drizzle;
    const [suggestion] = await db.select().from(schema.actionSuggestions);
    const { buildTrace, renderTrace } = await import('../src/observability/trace');
    const view = (await buildTrace(suggestion.id))!;

    expect(view.contentId).toBe(suggestion.contentId);
    expect(view.evaluation?.id).toBe(suggestion.evaluationId);
    const retrieve = view.traces.flatMap(t => t.events).find(e => e.stage === 'retrieve')!;
    expect(view.evaluation?.retrievalEventId).toBe(retrieve.id);
    expect(view.traces[0].llm.map(a => a.component)).toEqual(['summary', 'triage', 'structure']);

    const text = renderTrace(view);
    expect(text).toContain(`Selected by retrieval event: ${retrieve.id}`);
    expect(text).toContain('<- selected this suggestion');
    expect(text).toMatch(new RegExp(`#1 project ${suggestion.projectId} note distance 0 .*\\*`));
    expect(text).not.toContain(SENTINEL);

    // The same view from the content ID
    const byContent = (await buildTrace(suggestion.contentId))!;
    expect(byContent.traces.map(t => t.traceId)).toContain(retrieve.traceId);
    const [content] = await db.select().from(schema.contents).where(eq(schema.contents.id, suggestion.contentId));
    expect(content.traceId).toBe(retrieve.traceId);
  });

  it('records failures without leaking text, and no sentinel ever reaches the logs', async () => {
    const { eq } = drizzle;

    // 1. Triage fails with an error whose message quotes the model
    failTriage = true;
    const failing = await server.inject({ method: 'POST', url: '/api/ingest', payload: { url: FAILING_URL } });
    const failingId = failing.json().contentId;
    const failedJob = await waitFor(async () => {
      const rows = await db.select().from(schema.pipelineEvents).where(eq(schema.pipelineEvents.contentId, failingId));
      return rows.find((e: any) => e.stage === 'evaluate_job');
    });
    expect(failedJob).toMatchObject({ ok: false });
    expect(failedJob.attrs).toMatchObject({ failures: 1, evaluated: 0 });
    const failedTriage = await db.select().from(schema.llmTelemetry).where(eq(schema.llmTelemetry.contentId, failingId));
    expect(failedTriage.find((t: any) => t.component === 'triage')).toMatchObject({ isSuccess: false, errorKind: 'other' });

    // 2. Ingestion fails (404 on a URL that contains the sentinel)
    const missing = await server.inject({ method: 'POST', url: '/api/ingest', payload: { url: MISSING_URL } });
    const missingId = missing.json().contentId;
    const failedIngest = await waitFor(async () => {
      const rows = await db.select().from(schema.pipelineEvents).where(eq(schema.pipelineEvents.contentId, missingId));
      return rows.find((e: any) => e.stage === 'ingest_job');
    });
    expect(failedIngest).toMatchObject({ ok: false, attempt: 1 });
    expect(failedIngest.attrs).toMatchObject({ retryable: false });

    // 3. Reconcile a vault whose folder, note names and text carry the sentinel
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-trace-'));
    const projectDir = path.join(vault, 'Projects', `Proyecto ${SENTINEL}`);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, `nota ${SENTINEL}.md`), `# Título ${SENTINEL}\n\nTexto privado ${SENTINEL} #project`);
    await fs.writeFile(path.join(projectDir, 'rota.md'), '---\ntitle: [sin cerrar\n---\nTexto');
    const { reconcileProject } = await import('../src/vault/reconciler');
    await reconcileProject(projectDir, vault);
    await fs.rm(vault, { recursive: true, force: true });

    // Let any jobs the reconciliation enqueued run before checking the logs
    await new Promise(r => setTimeout(r, 3000));

    const logs = logLines.join('');
    expect(logLines.length).toBeGreaterThan(10);
    expect(logs).toContain('Triage failed for this project');
    expect(logs).toContain('Ingestion failed');
    expect(logs).toContain('Project synchronized');
    expect(logs).not.toContain(SENTINEL);
    expect(logs).not.toContain('articulo.example.org');
    expect(logs).not.toContain(vault);

    const observability = JSON.stringify([
      await db.select().from(schema.pipelineEvents),
      await db.select().from(schema.llmTelemetry),
    ]);
    expect(observability).not.toContain(SENTINEL);
    expect(observability).not.toContain('articulo.example.org');
  }, 90000);
});
