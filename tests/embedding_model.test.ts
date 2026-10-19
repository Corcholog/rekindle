import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Invariant I7 (audit F-17): distances are only compared between embeddings produced by the
// current EMBED_MODEL. Vectors from another model are never matched against current ones.
describe('Embedding model consistency', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  const vector = Array.from({ length: 1024 }, (_, i) => ((i * 13) % 17) / 17);

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
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.restoreAllMocks();
  });

  async function seed(folder: string, snapshotModel: string, contentModel: string) {
    const [project] = await db.insert(schema.projects).values({ folderPath: folder, title: folder }).returning();
    const [snapshot] = await db.insert(schema.projectSnapshots).values({
      projectId: project.id, treeHash: folder, thesisText: 'Tesis', notesContent: 'Notas',
      embedding: vector, embeddingModel: snapshotModel,
    }).returning();
    await db.insert(schema.projectNoteSnapshots).values({
      projectSnapshotId: snapshot.id, projectId: project.id, notePath: 'nota.md', noteTitle: 'Nota',
      embedding: vector, embeddingModel: snapshotModel,
    });
    const [content] = await db.insert(schema.contents).values({
      uri: `https://example.com/${folder}`, title: folder, summary: 'Resumen', ingestStatus: 'ready',
      embedding: vector, embeddingModel: contentModel,
    }).returning();
    return { project, snapshot, content };
  }

  it('never evaluates or backlogs content against a snapshot from another model', async () => {
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    const { evaluateContentMatch, findBacklogUnevaluatedContents } = await import('../src/evaluator');
    const llm = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValue({
      data: { verdict: 'irrelevant', confidenceScore: 0.1, triageReasoning: 'x', action: null },
      model: 'fake',
    } as any);

    // Identical vectors (distance 0), but the project snapshot comes from another model
    const mixed = await seed('Projects/Mixto', 'old-model', 'bge-m3');
    await evaluateContentMatch(mixed.content.id, mixed.project.id);
    expect(llm).not.toHaveBeenCalled();
    expect(await findBacklogUnevaluatedContents(mixed.project.id)).not.toContain(mixed.content.id);

    // Content embedded with another model is not evaluated either
    const oldContent = await seed('Projects/ContenidoViejo', 'bge-m3', 'old-model');
    await evaluateContentMatch(oldContent.content.id, oldContent.project.id);
    expect(llm).not.toHaveBeenCalled();

    // Same model on both sides: evaluated
    const same = await seed('Projects/Mismo', 'bge-m3', 'bge-m3');
    await evaluateContentMatch(same.content.id, same.project.id);
    expect(llm).toHaveBeenCalledTimes(1);
    llm.mockRestore();
  });

  it('records the model on new project snapshots', async () => {
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    const { reconcileProject } = await import('../src/vault/reconciler');
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');

    const embed = vi.spyOn(sharedAiProvider, 'getEmbedding').mockResolvedValue(vector);
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-model-'));
    const projectDir = path.join(vault, 'Projects', 'Nuevo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'idea.md'), '# Idea\nTexto');

    await reconcileProject(projectDir, vault);

    const { eq } = await import('drizzle-orm');
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.folderPath, 'Projects/Nuevo'));
    const [snapshot] = await db.select().from(schema.projectSnapshots).where(eq(schema.projectSnapshots.projectId, project.id));
    const notes = await db.select().from(schema.projectNoteSnapshots).where(eq(schema.projectNoteSnapshots.projectId, project.id));
    expect(snapshot.embeddingModel).toBe('bge-m3');
    expect(notes.every((n: any) => n.embeddingModel === 'bge-m3')).toBe(true);
    embed.mockRestore();
  });
});
