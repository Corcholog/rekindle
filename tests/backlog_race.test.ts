import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { installFakeAi, FakeAi } from './helpers/fakeAi';

// F-29: a backlog job queued because an article was never evaluated for a project could run after
// another job had evaluated it against an earlier snapshot, and evaluate it again: a second paid
// call and a second pending suggestion for the same article and project.

const vector = Array.from({ length: 1024 }, (_, i) => (i === 2 ? 1 : 0));
const answer = { connection: 'Conecta.', gap: null, verdict: 'actionable', confidenceScore: 0.9, action: { actionType: 'other', observation: 'o', suggestedAction: 'a', targetFile: null } };

describe('backlog jobs that run late', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let fake: FakeAi;

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
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    fake = installFakeAi(sharedAiProvider);
  }, 120000);

  afterAll(async () => {
    fake?.uninstall();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  async function seed(name: string) {
    const [project] = await db.insert(schema.projects).values({ folderPath: `Projects/${name}`, title: name }).returning();
    await db.insert(schema.projectSnapshots).values({ projectId: project.id, treeHash: `${name}-1`, thesisText: 'T', embedding: vector, embeddingModel: 'bge-m3', capturedAt: new Date(Date.now() - 60_000) });
    const [content] = await db.insert(schema.contents).values({ uri: `https://example.org/${name}`, summary: 'S', ingestStatus: 'ready', embedding: vector, embeddingModel: 'bge-m3' }).returning();
    const newSnapshot = () => db.insert(schema.projectSnapshots).values({ projectId: project.id, treeHash: `${name}-2`, thesisText: 'T2', embedding: vector, embeddingModel: 'bge-m3' });
    return { project, content, newSnapshot };
  }
  const counts = async (contentId: string) => {
    const { eq } = await import('drizzle-orm');
    return {
      evaluations: (await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, contentId))).length,
      suggestions: (await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, contentId))).length,
    };
  };

  it('skips an "unevaluated" job for a pair evaluated since it was queued', async () => {
    const { evaluateContentMatch, findBacklogCandidates } = await import('../src/evaluator');
    const { project, content, newSnapshot } = await seed('Carrera');
    expect(await findBacklogCandidates(project.id)).toEqual([{ contentId: content.id, reason: 'unevaluated' }]);

    const before = fake.calls.length;
    // One answer: a second call would get the fake's default (irrelevant) and show in the count
    fake.answerNext(answer);
    await evaluateContentMatch(content.id, project.id, {}, { backlog: 'unevaluated' }); // runs on snapshot 1
    await newSnapshot();
    await evaluateContentMatch(content.id, project.id, {}, { backlog: 'unevaluated' }); // the same job, delivered late
    expect(fake.calls.length - before).toBe(1);
    expect(await counts(content.id)).toEqual({ evaluations: 1, suggestions: 1 });
  });

  it('a promotion job still re-evaluates against the newer snapshot', async () => {
    const { evaluateContentMatch } = await import('../src/evaluator');
    const { project, content, newSnapshot } = await seed('Promocion');
    const before = fake.calls.length;
    fake.answerNext({ ...answer, verdict: 'tentative', confidenceScore: 0.5, action: null }, answer);
    await evaluateContentMatch(content.id, project.id, {}, { backlog: 'unevaluated' });
    await newSnapshot();
    await evaluateContentMatch(content.id, project.id, {}, { backlog: 'promotion' });
    expect(fake.calls.length - before).toBe(2);
    expect(await counts(content.id)).toEqual({ evaluations: 2, suggestions: 1 });
  });
});
