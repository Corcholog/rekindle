import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';

// `pnpm usertest:stats` output is pasted into session sheets: counts only, never content.
const SENTINEL = 'SENTINEL-texto-privado-9c1';

describe('usertest:stats', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let stats: typeof import('../src/usertest/stats');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    stats = await import('../src/usertest/stats');
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it('reports "not measured" on an empty database', async () => {
    const result = await stats.buildUserTestStats(db);
    expect(result).toMatchObject({ articlesReady: 0, acceptanceRate: null, secondsToFirstSuggestion: null });
    const text = stats.renderUserTestStats(result);
    expect(text).toContain('not measured');
  });

  it('counts suggestions, acceptance and reasons without leaking any text', async () => {
    const schema = await import('../src/db/schema');
    const [project] = await db.insert(schema.projects).values({ folderPath: `Projects/${SENTINEL}`, title: SENTINEL }).returning();
    const [snapshot] = await db.insert(schema.projectSnapshots).values({ projectId: project.id, treeHash: 'h' }).returning();
    const [content] = await db.insert(schema.contents).values({
      uri: `https://example.com/${SENTINEL}`, title: SENTINEL, summary: SENTINEL, rawText: SENTINEL, ingestStatus: 'ready',
    }).returning();
    await db.insert(schema.contents).values({ uri: 'https://example.com/roto', ingestStatus: 'failed', ingestStatusReason: SENTINEL });
    await db.execute(sql`UPDATE contents SET consumed_at = now() - interval '90 seconds' WHERE id = ${content.id}`);

    const make = async (seq: number, status: 'pending' | 'accepted' | 'discarded', reason?: string) => {
      const [evaluation] = await db.insert(schema.evaluations).values({
        contentId: content.id, projectSnapshotId: snapshot.id, verdict: 'actionable', confidenceScore: 0.8, triageReasoning: SENTINEL, consumptionSeq: seq,
      }).returning();
      await db.insert(schema.actionSuggestions).values({
        evaluationId: evaluation.id, projectId: project.id, contentId: content.id, actionType: 'other', targetFile: 'x.md',
        observation: SENTINEL, suggestedAction: SENTINEL, userFeedback: SENTINEL, status, discardReason: reason as any,
      });
    };
    await make(1, 'accepted');
    await make(2, 'accepted');
    await make(3, 'discarded', 'unrelated');
    await make(4, 'discarded', 'unrelated');
    await make(5, 'discarded');
    await make(6, 'pending');

    const result = await stats.buildUserTestStats(db);
    expect(result.articlesReady).toBe(1);
    expect(result.articlesFailed).toBe(1);
    expect(result.suggestions).toEqual({ total: 6, pending: 1, accepted: 2, discarded: 3 });
    expect(result.acceptanceRate).toBeCloseTo(2 / 5);
    expect(result.discardReasons).toMatchObject({ unrelated: 2, obvious: 0 });
    expect(result.discardsWithoutReason).toBe(1);
    expect(result.secondsToFirstSuggestion).toBeGreaterThanOrEqual(90);
    expect(result.secondsToFirstSuggestion).toBeLessThan(120);

    const text = stats.renderUserTestStats(result);
    expect(text).toContain('Acceptance rate (accepted / resolved): 40%');
    expect(text).toContain('no tiene relación: 2');
    expect(text + JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
