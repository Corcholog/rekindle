import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { installFakeAi, FakeAi } from './helpers/fakeAi';

// F-15: unmounting the vault's drive removes every project folder, and the watcher marks each one
// inactive. When the drive comes back with the same notes, the project must be active again, with
// no new snapshot and so no backlog re-evaluation.

describe('vault drive unmounted and mounted again', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let fake: FakeAi;
  let root: string;
  let vault: string;
  let projectDir: string;

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

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-remount-'));
    vault = path.join(root, 'vault');
    projectDir = path.join(vault, 'Projects', 'Faro');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'borrador.md'), '# Borrador\n\nUn faro en la costa.');
  }, 120000);

  afterAll(async () => {
    fake?.uninstall();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('reconciles nothing while the drive is gone, and reactivates the project when it is back', async () => {
    const { reconcileProject } = await import('../src/vault/reconciler');
    await reconcileProject(projectDir, vault);
    const snapshots = async () => (await db.select().from(schema.projectSnapshots)).length;
    expect(await snapshots()).toBe(1);
    const [project] = await db.select().from(schema.projects);

    // The drive disappears: the watcher marks the folder inactive, and a reconcile finds nothing
    await fs.rename(vault, path.join(root, 'off'));
    await db.update(schema.projects).set({ isActive: false });
    await reconcileProject(projectDir, vault);
    expect(await snapshots()).toBe(1);

    // The drive is back with the same notes
    await fs.rename(path.join(root, 'off'), vault);
    await reconcileProject(projectDir, vault);
    const [after] = await db.select().from(schema.projects);
    expect(after).toMatchObject({ id: project.id, isActive: true });
    // No new snapshot, so nothing is queued for re-evaluation (backlog runs only after a snapshot)
    expect(await snapshots()).toBe(1);
  }, 30000);
});
