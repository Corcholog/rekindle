import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// retrieveCandidates is the pure Step 1 of the evaluation: no LLM involved.
describe('retrieveCandidates', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  const unit = (i: number) => Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0));
  const near = (i: number, j: number, wiggle: number) => unit(i).map((v, k) => (k === j ? wiggle : v));

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

    const make = async (folder: string, projectVec: number[], notes: { path: string; vec: number[] }[], active = true) => {
      const [project] = await db.insert(schema.projects).values({ folderPath: folder, title: folder, isActive: active }).returning();
      const [snapshot] = await db.insert(schema.projectSnapshots).values({
        projectId: project.id, treeHash: folder, thesisText: `tesis ${folder}`, notesContent: `notas ${folder}`,
        embedding: projectVec, embeddingModel: 'bge-m3',
      }).returning();
      for (const note of notes) {
        await db.insert(schema.projectNoteSnapshots).values({
          projectSnapshotId: snapshot.id, projectId: project.id, notePath: note.path, noteTitle: note.path,
          contentSnippet: `extracto ${note.path}`, embedding: note.vec, embeddingModel: 'bge-m3',
        });
      }
      return project.id;
    };

    await make('Projects/Cerca', unit(0), [{ path: 'a.md', vec: near(0, 1, 0.1) }, { path: 'b.md', vec: unit(5) }]);
    await make('Projects/SoloProyecto', near(0, 2, 0.3), [{ path: 'x.md', vec: unit(9) }]);
    await make('Projects/Lejos', unit(7), [{ path: 'z.md', vec: unit(8) }]);
    await make('Projects/Inactivo', unit(0), [{ path: 'i.md', vec: unit(0) }], false);
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.restoreAllMocks();
  });

  it('returns active projects within the threshold, closest first, with the matching note', async () => {
    const { retrieveCandidates } = await import('../src/evaluator/retrieval');
    const candidates = await retrieveCandidates(unit(0));

    expect(candidates.map(c => c.notePath ?? c.level)).toEqual(['a.md', 'project']);
    expect(candidates[0].level).toBe('note');
    expect(candidates[0].noteSnippet).toBe('extracto a.md');
    expect(candidates[0].distance).toBeLessThan(candidates[1].distance);
    expect(candidates[1].level).toBe('project');
    expect(candidates.every(c => c.thesisText.startsWith('tesis'))).toBe(true);
  });

  it('honors threshold, limit and project filter', async () => {
    const { retrieveCandidates } = await import('../src/evaluator/retrieval');
    expect(await retrieveCandidates(unit(0), { threshold: 0 })).toHaveLength(0);
    expect(await retrieveCandidates(unit(0), { limit: 1 })).toHaveLength(1);

    const all = await retrieveCandidates(unit(0));
    const only = await retrieveCandidates(unit(0), { targetProjectId: all[1].projectId });
    expect(only.map(c => c.projectId)).toEqual([all[1].projectId]);
  });

  it('ignores snapshots from another embedding model (I7)', async () => {
    const { retrieveCandidates } = await import('../src/evaluator/retrieval');
    expect(await retrieveCandidates(unit(0), { embedModel: 'other-model' })).toHaveLength(0);
  });
});
