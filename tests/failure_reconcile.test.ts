import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fakeEmbedding } from './helpers/fakeAi';

// Audit failure scenario 4: Obsidian changes a note while Loom reconciles the project. The
// watcher calls reconcileProject again on the change; the per-project lock queues a follow-up
// pass, and the final snapshot must match the files on disk.

describe('Failure scenario 4: a note changes during reconciliation', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let vault: string;

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
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-reconcile-'));
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    await fs.rm(vault, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('ends with a snapshot of the final note content and its hash', async () => {
    const projectDir = path.join(vault, 'Projects', 'Novela');
    const notePath = path.join(projectDir, 'borrador.md');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(notePath, '# Borrador\n\nPrimera versión del capítulo sobre el faro.');

    // Slow embeddings keep the first pass running while the note is edited
    let releaseFirstPass!: () => void;
    const firstPassBlocked = new Promise<void>(resolve => { releaseFirstPass = resolve; });
    let embedCalls = 0;
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    sharedAiProvider.setOverrides({
      embed: async (text: string) => {
        if (++embedCalls === 1) await firstPassBlocked;
        return fakeEmbedding(text);
      },
    });

    const { reconcileProject } = await import('../src/vault/reconciler');
    const { getDirectoryHash } = await import('../src/vault/hash');
    const firstPass = reconcileProject(projectDir, vault);
    await vi.waitFor(() => expect(embedCalls).toBe(1));

    // Obsidian saves an edit mid-reconcile, and the watcher fires
    await fs.writeFile(notePath, '# Borrador\n\nSegunda versión: el farero desaparece en la tormenta.');
    await reconcileProject(projectDir, vault); // returns at once: queued behind the running pass
    releaseFirstPass();
    await firstPass;

    const finalHash = await getDirectoryHash(projectDir);
    const { eq, desc } = await import('drizzle-orm');
    const latest = async () => {
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.folderPath, 'Projects/Novela'));
      const [snapshot] = await db.select().from(schema.projectSnapshots)
        .where(eq(schema.projectSnapshots.projectId, project.id)).orderBy(desc(schema.projectSnapshots.capturedAt)).limit(1);
      return { project, snapshot };
    };
    // The follow-up pass runs on its own (setImmediate)
    await vi.waitFor(async () => expect((await latest()).snapshot.treeHash).toBe(finalHash), { timeout: 10000 });

    const { project, snapshot } = await latest();
    expect(project.currentHash).toBe(finalHash);
    expect(snapshot.notesContent).toContain('Segunda versión');
    expect(snapshot.notesContent).not.toContain('Primera versión');
    const notes = await db.select().from(schema.projectNoteSnapshots).where(eq(schema.projectNoteSnapshots.projectSnapshotId, snapshot.id));
    expect(notes).toHaveLength(1);
    expect(notes[0].contentSnippet).toContain('Segunda versión');
    expect(notes[0].embedding).toEqual(expect.any(Array));
  }, 30000);

  // Threat model: a symlink inside a project must not pull files from outside the vault into
  // prompts or the database
  it('skips symlinked notes and folders inside a project', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-outside-'));
    await fs.writeFile(path.join(outside, 'secreto.md'), '# Secreto\n\nTEXTO-FUERA-DEL-VAULT');
    const projectDir = path.join(vault, 'Projects', 'Enlaces');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'nota.md'), '# Nota\n\nTexto propio del proyecto.');
    await fs.symlink(path.join(outside, 'secreto.md'), path.join(projectDir, 'enlace.md'));
    await fs.symlink(outside, path.join(projectDir, 'carpeta-enlazada'));

    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    sharedAiProvider.setOverrides({ embed: async (text: string) => fakeEmbedding(text) });
    const { reconcileProject } = await import('../src/vault/reconciler');
    await reconcileProject(projectDir, vault, true);

    const { eq } = await import('drizzle-orm');
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.folderPath, 'Projects/Enlaces'));
    const [snapshot] = await db.select().from(schema.projectSnapshots).where(eq(schema.projectSnapshots.projectId, project.id));
    const notes = await db.select().from(schema.projectNoteSnapshots).where(eq(schema.projectNoteSnapshots.projectSnapshotId, snapshot.id));
    expect(notes.map((n: any) => n.notePath)).toEqual(['nota.md']);
    expect(JSON.stringify([snapshot, notes])).not.toContain('TEXTO-FUERA-DEL-VAULT');
    await fs.rm(outside, { recursive: true, force: true });
  });
});
