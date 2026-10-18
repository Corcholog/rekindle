import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Only the closest few projects are handed to the LLM per article (cost control, see evals/SWEEP.md:
// the 3 closest keep 86% of the relevant pairs at 45% fewer calls).
describe('projects evaluated per article', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  const unit = (i: number) => Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0));
  const near = (wiggle: number) => unit(0).map((v, k) => (k === 1 ? wiggle : v));

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

    // Five active projects, all within the distance threshold, at increasing distance
    for (const [i, wiggle] of [0, 0.1, 0.2, 0.3, 0.4].entries()) {
      const [project] = await db.insert(schema.projects).values({ folderPath: `Projects/P${i}`, title: `P${i}` }).returning();
      await db.insert(schema.projectSnapshots).values({
        projectId: project.id, treeHash: `h${i}`, thesisText: `tesis ${i}`, notesContent: `notas ${i}`,
        embedding: near(wiggle), embeddingModel: 'bge-m3',
      });
    }
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.restoreAllMocks();
  });

  it('defaults to the 3 closest projects', async () => {
    const { TOP_K_PROJECTS_LIMIT } = await import('../src/config');
    expect(TOP_K_PROJECTS_LIMIT).toBe(3);
  });

  it('asks the model about only the closest projects, even when more pass the threshold', async () => {
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    const { evaluateContentMatch } = await import('../src/evaluator');
    const llm = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValue({
      data: { verdict: 'irrelevant', confidenceScore: 0.1, triageReasoning: 'x', action: null },
      model: 'fake',
    } as any);

    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/a', title: 'A', summary: 'Resumen', ingestStatus: 'ready',
      embedding: unit(0), embeddingModel: 'bge-m3',
    }).returning();
    await evaluateContentMatch(content.id);

    expect(llm).toHaveBeenCalledTimes(3);
    const prompts = llm.mock.calls.map(call => String(call[1]));
    expect(prompts.every(p => /notas [012]\b/.test(p))).toBe(true); // P0, P1, P2 only
    expect(prompts.some(p => /notas [34]\b/.test(p))).toBe(false);
    llm.mockRestore();
  }, 120000);
});
