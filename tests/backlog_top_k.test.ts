import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// A new snapshot (a note edit, a new or reactivated project) queues backlog evaluations. An article
// never evaluated for the project goes to the model only if the project is among the article's 3
// closest, as when it was clipped; otherwise every note edit would send rank-4+ pairs to a paid model.

const DIMENSIONS = 1024;
/** A unit vector at cosine distance `distance` from the first axis, leaning towards axis `axis`. */
function vectorAt(distance: number, axis: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  const similarity = 1 - distance;
  v[0] = similarity;
  v[axis] = Math.sqrt(1 - similarity * similarity);
  return v;
}

describe('backlog evaluations respect the top-3 cutoff', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let contentId: string;
  const projectIds: string[] = [];

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

    // Four projects within the 0.6 threshold of the article, at distances 0.1 to 0.4
    for (const [i, distance] of [0.1, 0.2, 0.3, 0.4].entries()) {
      const [project] = await db.insert(schema.projects).values({ folderPath: `Projects/P${i + 1}`, title: `P${i + 1}` }).returning();
      await db.insert(schema.projectSnapshots).values({
        projectId: project.id, treeHash: `p${i + 1}`, thesisText: 'Tesis', embedding: vectorAt(distance, i + 1), embeddingModel: 'bge-m3',
      });
      projectIds.push(project.id);
    }
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/articulo', summary: 'Resumen', ingestStatus: 'ready', embedding: vectorAt(0, 100), embeddingModel: 'bge-m3',
    }).returning();
    contentId = content.id;
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it('queues an article only for projects among its 3 closest', async () => {
    const { findBacklogUnevaluatedContents } = await import('../src/evaluator');
    // Never evaluated against any project: the three closest pick it up, the fourth does not
    for (const id of projectIds.slice(0, 3)) expect(await findBacklogUnevaluatedContents(id)).toEqual([contentId]);
    expect(await findBacklogUnevaluatedContents(projectIds[3])).toEqual([]);
  });

  it('still re-checks a tentative evaluation the project moved closer to, whatever its rank', async () => {
    const { findBacklogUnevaluatedContents } = await import('../src/evaluator');
    // The 4th project was evaluated tentative against an older, farther snapshot (0.55)...
    const [older] = await db.insert(schema.projectSnapshots).values({
      projectId: projectIds[3], treeHash: 'p4-old', thesisText: 'Tesis', embedding: vectorAt(0.55, 4), embeddingModel: 'bge-m3',
      capturedAt: new Date(Date.now() - 60_000),
    }).returning();
    await db.insert(schema.evaluations).values({
      contentId, projectSnapshotId: older.id, verdict: 'tentative', confidenceScore: 0.5, triageReasoning: 'Tangencial', consumptionSeq: 1,
    });
    // ...and its latest snapshot (0.4, still 4th) is closer by more than the promotion delta
    expect(await findBacklogUnevaluatedContents(projectIds[3])).toEqual([contentId]);
  });

  it('a project created after the article picks it up when it ranks among its 3 closest', async () => {
    const { findBacklogUnevaluatedContents } = await import('../src/evaluator');
    const [project] = await db.insert(schema.projects).values({ folderPath: 'Projects/Nuevo', title: 'Nuevo' }).returning();
    await db.insert(schema.projectSnapshots).values({
      projectId: project.id, treeHash: 'nuevo', thesisText: 'Tesis', embedding: vectorAt(0.05, 9), embeddingModel: 'bge-m3',
    });
    expect(await findBacklogUnevaluatedContents(project.id)).toEqual([contentId]);
    // It pushed the old 3rd project out of the top 3
    expect(await findBacklogUnevaluatedContents(projectIds[2])).toEqual([]);
  });
});
