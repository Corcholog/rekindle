import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';

// Migration 0006 (Phase 4): pipeline events, per-attempt LLM telemetry and trace links.
describe('Observability schema', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it('links an evaluation to its trace and retrieval event, and survives deleting the event', async () => {
    const traceId = crypto.randomUUID();
    const [content] = await db.insert(schema.contents).values({ uri: 'https://example.com/a', traceId }).returning();
    const [project] = await db.insert(schema.projects).values({ folderPath: 'Projects/A', title: 'A' }).returning();
    const [snapshot] = await db.insert(schema.projectSnapshots).values({ projectId: project.id, treeHash: 'h' }).returning();
    const [event] = await db.insert(schema.pipelineEvents).values({
      traceId, stage: 'retrieve', contentId: content.id, durationMs: 12,
      attrs: { threshold: 0.6, limit: 3, candidates: [{ projectId: project.id, distance: 0.4, rank: 1 }] },
    }).returning();
    const [evaluation] = await db.insert(schema.evaluations).values({
      contentId: content.id, projectSnapshotId: snapshot.id, consumptionSeq: 1, traceId, retrievalEventId: event.id,
    }).returning();

    expect(evaluation.retrievalEventId).toBe(event.id);
    expect(event.attrs.candidates[0].rank).toBe(1);

    await db.delete(schema.pipelineEvents).where(eq(schema.pipelineEvents.id, event.id));
    const [after] = await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluation.id));
    expect(after.retrievalEventId).toBeNull();
  });

  it('stores one telemetry row per attempt for the new components', async () => {
    const traceId = crypto.randomUUID();
    await db.insert(schema.llmTelemetry).values([
      { component: 'consult', traceId, provider: 'deepseek', modelName: 'deepseek:deepseek-flash', attemptNo: 1, isSuccess: false, errorKind: 'rate_limit' },
      { component: 'consult', traceId, provider: 'gemini', modelName: 'gemini:x', attemptNo: 2, isFallback: true, promptChars: 120, completionChars: 40, promptHash: 'abcdef0123456789' },
    ]);
    const rows = await db.select().from(schema.llmTelemetry).where(eq(schema.llmTelemetry.traceId, traceId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r: any) => r.isFallback).provider).toBe('gemini');
  });
});
