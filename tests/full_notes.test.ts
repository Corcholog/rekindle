import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fakeEmbedding } from './helpers/fakeAi';

// Notes are stored in full so the model can read all of them, while every embedding input stays
// exactly what it was when note text was cut at 4,000 characters: retrieval and staleness do not move.

describe('Full note text in snapshots', () => {
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
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-full-notes-'));
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    await fs.rm(vault, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('stores a long note whole and embeds the same text as before', async () => {
    const projectDir = path.join(vault, 'Projects', 'Ensayo');
    await fs.mkdir(path.join(projectDir, 'research'), { recursive: true });
    const longBody = `${'Primera parte del ensayo. '.repeat(250)}FINAL-DE-LA-NOTA`;
    expect(longBody.length).toBeGreaterThan(6000);
    await fs.writeFile(path.join(projectDir, 'borrador.md'), `# Borrador\n\n${longBody}`);
    await fs.writeFile(path.join(projectDir, 'research', 'fuentes.md'), '# Fuentes\n\nLibros sobre atención.');

    const embedded: string[] = [];
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    sharedAiProvider.setOverrides({ embed: async (text: string) => { embedded.push(text); return fakeEmbedding(text); } });

    const { reconcileProject } = await import('../src/vault/reconciler');
    await reconcileProject(projectDir, vault);

    const { eq } = await import('drizzle-orm');
    const [snapshot] = await db.select().from(schema.projectSnapshots);
    const notes = await db.select().from(schema.projectNoteSnapshots).where(eq(schema.projectNoteSnapshots.projectSnapshotId, snapshot.id));
    const draft = notes.find((n: any) => n.notePath === 'borrador.md');
    expect(draft.contentSnippet).toBe(longBody);

    // The embedding inputs and the project text are built from the first 4,000 characters, as before
    const cut = longBody.substring(0, 4000);
    expect(embedded).toContain(`Nota: Borrador\n\n${longBody}`.substring(0, 4000));
    expect(embedded).toContain('Nota: Fuentes\n\nLibros sobre atención.');
    const legacyNotes = `### Nota: Borrador\n${cut}\n\n### Nota: Fuentes\nLibros sobre atención.\n\n`;
    expect(snapshot.notesContent).toBe(legacyNotes);
    expect(embedded).toContain(`Proyecto: Ensayo\n\n${legacyNotes}`.substring(0, 6000));
    expect(embedded.join('\n')).not.toContain('FINAL-DE-LA-NOTA');
  }, 30000);
});
