import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFile } from 'child_process';
import { promisify } from 'util';

// pnpm telemetry:report / telemetry:prune on hand-built rows with hand-computed expectations.

const DAY = 86_400_000;

describe('Telemetry report', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let report: typeof import('../src/observability/report');
  let oldEventId: string;
  let evaluationId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
    report = await import('../src/observability/report');

    const t = (component: string, provider: string, model: string, attemptNo: number, extra: Record<string, unknown> = {}) => ({
      component, provider, modelName: `${provider}:${model}`, attemptNo, isSuccess: true, isFallback: false, ...extra,
    });
    await db.insert(schema.llmTelemetry).values([
      // Triage call A: DeepSeek answers first time
      t('triage', 'deepseek', 'deepseek-flash', 1, { latencyMs: 100, promptTokens: 1000, completionTokens: 100, costUsd: 0.00042 }),
      // Triage call B: DeepSeek rate limited, Gemini answers (fallback, unpriced)
      t('triage', 'deepseek', 'deepseek-flash', 1, { isSuccess: false, errorKind: 'rate_limit', latencyMs: 50 }),
      t('triage', 'gemini', 'gemini-3.1-flash-lite', 2, { isFallback: true, latencyMs: 300, promptTokens: 500, completionTokens: 50 }),
      // Triage call C: Ollama malformed once, then answers (same provider: not a fallback)
      t('triage', 'ollama', 'qwen2.5:7b-instruct', 1, { isSuccess: false, errorKind: 'invalid_json', latencyMs: 10 }),
      t('triage', 'ollama', 'qwen2.5:7b-instruct', 2, { latencyMs: 20, promptTokens: 10, completionTokens: 5, costUsd: 0 }),
      // Summary call D: every provider fails
      t('summary', 'deepseek', 'deepseek-flash', 1, { isSuccess: false, errorKind: 'http', latencyMs: 40 }),
      t('summary', 'ollama', 'qwen2.5:7b-instruct', 2, { isSuccess: false, errorKind: 'http', isFallback: true, latencyMs: 5 }),
      // Outside the period
      t('triage', 'deepseek', 'deepseek-flash', 1, { latencyMs: 9999, costUsd: 5, createdAt: new Date(Date.now() - 30 * DAY) }),
    ]);

    const trace = crypto.randomUUID();
    const e = (stage: string, durationMs: number, extra: Record<string, unknown> = {}) => ({ traceId: trace, stage, durationMs, ok: true, ...extra });
    await db.insert(schema.pipelineEvents).values([
      e('retrieve', 10), e('retrieve', 20), e('retrieve', 30), e('retrieve', 40, { ok: false, errorKind: 'error' }),
      e('evaluate_job', 500), e('evaluate_job', 700, { ok: false, errorKind: 'llm_chain' }),
      e('ingest_job', 50, { ok: false, errorKind: 'SsrfBlockedError' }),
    ]);
    const [oldEvent] = await db.insert(schema.pipelineEvents).values(e('retrieve', 1, { createdAt: new Date(Date.now() - 30 * DAY) })).returning();
    oldEventId = oldEvent.id;

    // An evaluation selected by the old retrieval event survives pruning
    const [content] = await db.insert(schema.contents).values({ uri: 'https://example.com/x' }).returning();
    const [project] = await db.insert(schema.projects).values({ folderPath: 'Projects/X', title: 'X' }).returning();
    const [snapshot] = await db.insert(schema.projectSnapshots).values({ projectId: project.id, treeHash: 'h' }).returning();
    const [evaluation] = await db.insert(schema.evaluations).values({
      contentId: content.id, projectSnapshotId: snapshot.id, consumptionSeq: 1, retrievalEventId: oldEventId,
    }).returning();
    evaluationId = evaluation.id;
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it('computes rates, latencies, tokens and cost over the period', async () => {
    const r = await report.buildReport({ since: report.parseSince('7d') });

    const triage = r.components.find(c => c.component === 'triage')!;
    expect(triage).toMatchObject({
      calls: 3, failedCalls: 0, fallbackCalls: 1, retries: 2,
      p50Ms: 100, p95Ms: 280, // successful latencies 20, 100, 300; p95 = 100 + 0.9 * 200
      promptTokens: 1510, completionTokens: 155,
    });
    expect(triage.costUsd).toBeCloseTo(0.00042, 10);
    expect(r.components.find(c => c.component === 'summary')).toMatchObject({ calls: 1, failedCalls: 1, fallbackCalls: 0, retries: 1, p50Ms: null });

    expect(r.totals).toMatchObject({ calls: 4, failedCalls: 1, fallbackCalls: 1, attempts: 7, malformedAttempts: 1, unpricedAttempts: 1, failedJobs: 2 });
    expect(r.totals.costUsd).toBeCloseTo(0.00042, 10);

    const byProvider = Object.fromEntries(r.providers.map(p => [p.provider, p]));
    expect(byProvider.deepseek).toMatchObject({ model: 'deepseek-flash', attempts: 3, ok: 1, rateLimited: 1, otherErrors: 1, malformed: 0 });
    expect(byProvider.gemini).toMatchObject({ attempts: 1, ok: 1, unpriced: 1, costUsd: 0 });
    expect(byProvider.ollama).toMatchObject({ model: 'qwen2.5:7b-instruct', attempts: 3, ok: 1, malformed: 1, otherErrors: 1 });

    const retrieve = r.stages.find(s => s.stage === 'retrieve')!;
    expect(retrieve).toMatchObject({ events: 4, failures: 1, p50Ms: 25, p95Ms: 39 }); // 30 + 0.85 * 10 = 38.5
    expect(r.totals.jobErrors).toEqual(expect.arrayContaining([
      { stage: 'evaluate_job', errorKind: 'llm_chain', count: 1 },
      { stage: 'ingest_job', errorKind: 'SsrfBlockedError', count: 1 },
    ]));

    const text = report.renderReport(r);
    expect(text).toContain('LLM calls: 4 · failure rate 25.0% · fallback rate 33.3%');
    expect(text).toContain('not priced');
  });

  it('parses periods', () => {
    const now = new Date('2026-10-18T12:00:00Z');
    expect(report.parseSince('24h', now).toISOString()).toBe('2026-10-17T12:00:00.000Z');
    expect(report.parseSince('30m', now).toISOString()).toBe('2026-10-18T11:30:00.000Z');
    expect(report.parseSince('2026-10-01', now).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(() => report.parseSince('soon', now)).toThrow(/Invalid period/);
  });

  it('prunes only rows older than the cutoff and keeps evaluations', async () => {
    const { eq } = await import('drizzle-orm');
    const deleted = await report.pruneTelemetry(report.parseSince('10d'));
    expect(deleted).toEqual({ llmTelemetry: 1, pipelineEvents: 1 });

    expect(await db.select().from(schema.pipelineEvents).where(eq(schema.pipelineEvents.id, oldEventId))).toHaveLength(0);
    const [evaluation] = await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId));
    expect(evaluation.retrievalEventId).toBeNull();
    expect((await report.buildReport({ since: report.parseSince('7d') })).totals.calls).toBe(4);
  });

  it('refuses to prune without an explicit age', async () => {
    const run = promisify(execFile);
    const attempt = run('node_modules/.bin/tsx', ['src/observability/cli.ts', 'prune'], { env: { ...process.env, DATABASE_URL: 'postgres://x:x@127.0.0.1:9/none' } });
    await expect(attempt).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--older-than') });
  }, 30000);
});
