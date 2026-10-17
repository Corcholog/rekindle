import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Audit F-06 / invariant I5: exactly one callout per accepted suggestion,
// even after a crash, a failed write, a retry or concurrent writers.
describe('Writeback idempotency and recovery', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let vaultPath: string;
  let projectId: string;
  let evaluationId: string;
  let contentId: string;
  const projectFolder = 'Projects/Ensayo';

  const suggestionsFile = () => path.join(vaultPath, projectFolder, 'suggestions.md');
  const countCallouts = async () => {
    const text = await fs.readFile(suggestionsFile(), 'utf-8').catch(() => '');
    return (text.match(/\[!tip\] Sugerencia Aceptada/g) || []).length;
  };

  async function createAcceptedSuggestion(): Promise<string> {
    const [row] = await db.insert(schema.actionSuggestions).values({
      evaluationId, projectId, contentId,
      actionType: 'evidence_citation',
      targetFile: 'ideas.md',
      observation: 'Observación de prueba',
      suggestedAction: 'Citar la fuente en el capítulo 2',
      status: 'accepted',
      resolvedAt: new Date(),
    }).returning({ id: schema.actionSuggestions.id });
    return row.id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');

    const [project] = await db.insert(schema.projects).values({ folderPath: projectFolder, title: 'Ensayo' }).returning();
    projectId = project.id;
    const [snapshot] = await db.insert(schema.projectSnapshots).values({ projectId, treeHash: 'h' }).returning();
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/fuente', title: 'Fuente', ingestStatus: 'ready',
    }).returning();
    contentId = content.id;
    const [evaluation] = await db.insert(schema.evaluations).values({
      contentId, projectSnapshotId: snapshot.id, verdict: 'actionable', consumptionSeq: 1,
    }).returning();
    evaluationId = evaluation.id;
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
  });

  beforeEach(async () => {
    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-writeback-'));
    await fs.mkdir(path.join(vaultPath, projectFolder), { recursive: true });
  });

  it('writes one callout with a recovery marker and is a no-op the second time', async () => {
    const { writeAcceptedSuggestionToVault } = await import('../src/vault/updater');
    const id = await createAcceptedSuggestion();

    expect(await writeAcceptedSuggestionToVault(id, vaultPath)).toBe(true);
    expect(await writeAcceptedSuggestionToVault(id, vaultPath)).toBe(false);

    const text = await fs.readFile(suggestionsFile(), 'utf-8');
    expect(text).toContain(`%% loom:${id} %%`);
    expect(await countCallouts()).toBe(1);
  });

  it('recovers after a crash between the append and the DB flag without duplicating', async () => {
    const { writeAcceptedSuggestionToVault, formatAcceptedCallout } = await import('../src/vault/updater');
    const id = await createAcceptedSuggestion();

    // Simulate a crash: the callout reached the file but written_to_vault is still false
    await fs.writeFile(suggestionsFile(), formatAcceptedCallout({
      id, actionType: 'evidence_citation', observation: 'Observación de prueba',
      suggestedAction: 'Citar la fuente en el capítulo 2', userFeedback: null,
      sourceUri: 'https://example.com/fuente', sourceTitle: 'Fuente',
    }));

    expect(await writeAcceptedSuggestionToVault(id, vaultPath)).toBe(false);
    expect(await countCallouts()).toBe(1);

    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.id, id));
    expect(row.writtenToVault).toBe(true);
  });

  it('keeps the suggestion pending when the write fails, then recovers it', async () => {
    const { writeAcceptedSuggestionToVault, syncAllPendingWritebacks } = await import('../src/vault/updater');
    const id = await createAcceptedSuggestion();

    // A directory where suggestions.md should be makes every read and append fail
    await fs.mkdir(suggestionsFile());
    await expect(writeAcceptedSuggestionToVault(id, vaultPath)).rejects.toThrow();

    const { eq } = await import('drizzle-orm');
    const [pending] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.id, id));
    expect(pending.writtenToVault).toBe(false);

    await fs.rmdir(suggestionsFile());
    await syncAllPendingWritebacks(vaultPath);
    expect(await countCallouts()).toBe(1);
    const [done] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.id, id));
    expect(done.writtenToVault).toBe(true);
  });

  it('writes exactly once under concurrent writers', async () => {
    const { writeAcceptedSuggestionToVault } = await import('../src/vault/updater');
    const id = await createAcceptedSuggestion();

    const results = await Promise.all(Array.from({ length: 5 }, () => writeAcceptedSuggestionToVault(id, vaultPath)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await countCallouts()).toBe(1);
  });

  it('does not create a missing project folder (e.g. after switching vaults)', async () => {
    const { writeAcceptedSuggestionToVault } = await import('../src/vault/updater');
    const id = await createAcceptedSuggestion();
    await fs.rm(path.join(vaultPath, projectFolder), { recursive: true });

    await expect(writeAcceptedSuggestionToVault(id, vaultPath)).rejects.toThrow(/no existe/);
    expect(await fs.access(path.join(vaultPath, projectFolder)).then(() => true).catch(() => false)).toBe(false);
  });
});
