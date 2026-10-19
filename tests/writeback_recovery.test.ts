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
  let snapshotId: string;
  let contentId: string;
  let seq = 0;
  const projectFolder = 'Projects/Ensayo';

  const suggestionsFile = () => path.join(vaultPath, projectFolder, 'suggestions.md');
  const countCallouts = async () => {
    const text = await fs.readFile(suggestionsFile(), 'utf-8').catch(() => '');
    return (text.match(/\[!tip\] Sugerencia Aceptada/g) || []).length;
  };

  async function createAcceptedSuggestion(status: 'accepted' | 'pending' = 'accepted'): Promise<string> {
    // Each evaluation yields at most one suggestion
    const [evaluation] = await db.insert(schema.evaluations).values({
      contentId, projectSnapshotId: snapshotId, verdict: 'actionable', consumptionSeq: ++seq,
    }).returning();
    const [row] = await db.insert(schema.actionSuggestions).values({
      evaluationId: evaluation.id, projectId, contentId,
      actionType: 'evidence_citation',
      targetFile: 'ideas.md',
      observation: 'Observación de prueba',
      suggestedAction: 'Citar la fuente en el capítulo 2',
      status,
      resolvedAt: status === 'accepted' ? new Date() : null,
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
    snapshotId = snapshot.id;
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/fuente', title: 'Fuente', ingestStatus: 'ready',
    }).returning();
    contentId = content.id;
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
  });

  beforeEach(async () => {
    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-writeback-'));
    await fs.mkdir(path.join(vaultPath, projectFolder), { recursive: true });
  });

  it('writes one callout with a recovery marker and is a no-op the second time', async () => {
    const { writeAcceptedSuggestionToVault } = await import('../src/vault/updater');
    const id = await createAcceptedSuggestion();

    expect(await writeAcceptedSuggestionToVault(id, vaultPath)).toBe(true);
    expect(await writeAcceptedSuggestionToVault(id, vaultPath)).toBe(false);

    const text = await fs.readFile(suggestionsFile(), 'utf-8');
    expect(text).toContain(`%% rekindle:${id} %%`);
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

  // The project was called Loom before 2026-10-19: callouts in existing vaults carry the old marker
  it('treats a callout with the pre-rename marker as already written', async () => {
    const { writeAcceptedSuggestionToVault, formatAcceptedCallout, calloutMarker, legacyCalloutMarker } = await import('../src/vault/updater');
    const id = await createAcceptedSuggestion();
    const oldCallout = formatAcceptedCallout({
      id, actionType: 'evidence_citation', observation: 'Observación de prueba',
      suggestedAction: 'Citar la fuente en el capítulo 2', userFeedback: null,
      sourceUri: 'https://example.com/fuente', sourceTitle: 'Fuente',
    }).replace(calloutMarker(id), legacyCalloutMarker(id));
    await fs.writeFile(suggestionsFile(), oldCallout);

    expect(await writeAcceptedSuggestionToVault(id, vaultPath)).toBe(false);
    const text = await fs.readFile(suggestionsFile(), 'utf-8');
    expect(text.split(legacyCalloutMarker(id)).length - 1).toBe(1);
    expect(text).not.toContain(calloutMarker(id));
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

  // Audit failure scenario 5, through the route the UI calls
  it('accepting while the disk write fails answers accepted-but-pending and queues a sync that writes once', async () => {
    const Fastify = (await import('fastify')).default;
    const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
    const { boss } = await import('../src/queue/index');
    const sendSpy = vi.spyOn(boss, 'send').mockResolvedValue('job-id');
    vi.stubEnv('VAULT_PATH', vaultPath);
    const server = Fastify();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.register((await import('../src/api/routes/suggestions')).default);
    await server.ready();

    const id = await createAcceptedSuggestion('pending');
    await fs.mkdir(suggestionsFile()); // every read and append of suggestions.md fails
    const res = await server.inject({ method: 'PATCH', url: `/api/suggestions/${id}`, payload: { status: 'accepted' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: 'accepted', writtenToVault: false });
    expect(sendSpy).toHaveBeenCalledWith('sync_suggestions', { projectId }, expect.objectContaining({ retryLimit: expect.any(Number) }));

    // The disk recovers; the queued sync job (vaultWorker) writes the callout once
    await fs.rmdir(suggestionsFile());
    const { syncProjectSuggestions } = await import('../src/vault/updater');
    await syncProjectSuggestions(projectId, vaultPath);
    await syncProjectSuggestions(projectId, vaultPath);
    // Earlier tests left other accepted suggestions in this project; count this one's marker
    const text = await fs.readFile(suggestionsFile(), 'utf-8');
    expect(text.split(`%% rekindle:${id} %%`).length - 1).toBe(1);
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.id, id));
    expect(row.writtenToVault).toBe(true);

    await server.close();
    sendSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
  });
});
