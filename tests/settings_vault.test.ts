import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Settings API & Vault Path Change Scenarios', () => {
  let container: any;
  let vaultA: string;
  let vaultB: string;
  let server: any;
  let projectId: string;

  beforeAll(async () => {
    // 1. Setup Postgres Test Container
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('loomdb_settings_test')
      .withUsername('tester')
      .withPassword('testpass')
      .start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    // 2. Setup Vault A with a Project
    vaultA = path.join(__dirname, 'DummyVault_Settings_A');
    await fs.mkdir(path.join(vaultA, 'Projects', 'AI_Agents'), { recursive: true });
    await fs.writeFile(
      path.join(vaultA, 'Projects', 'AI_Agents', 'project.md'),
      '# Agentes Autónomos\n#project\n\nTesis sobre agentes distribuidos.',
      'utf-8'
    );

    // 3. Setup Vault B without AI_Agents (has different project)
    vaultB = path.join(__dirname, 'DummyVault_Settings_B');
    await fs.mkdir(path.join(vaultB, 'Projects', 'Data_Pipelines'), { recursive: true });
    await fs.writeFile(
      path.join(vaultB, 'Projects', 'Data_Pipelines', 'project.md'),
      '# Data Pipelines\n#project\n\nTesis sobre procesamiento streaming.',
      'utf-8'
    );

    // Start with Vault A
    vi.stubEnv('VAULT_PATH', vaultA);

    // 4. Init DB schema
    const { pool, db: drizzleDb } = await import('../src/db/index');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(drizzleDb, { migrationsFolder: './drizzle' });

    // Seed Project and a Suggestion in Vault A
    const { projects, projectSnapshots, contents, evaluations, actionSuggestions } = await import('../src/db/schema');
    const [proj] = await drizzleDb.insert(projects).values({
      folderPath: 'Projects/AI_Agents',
      title: 'AI Agents',
      isActive: true,
    }).returning({ id: projects.id });
    projectId = proj.id;

    const dummy1024 = new Array(1024).fill(0.02);

    const [snap] = await drizzleDb.insert(projectSnapshots).values({
      projectId,
      treeHash: 'hash-init',
      thesisText: 'Tesis de prueba',
      embedding: dummy1024,
    }).returning({ id: projectSnapshots.id });

    const [c] = await drizzleDb.insert(contents).values({
      uri: 'https://example.com/test',
      title: 'Ejemplo Test',
      summary: 'Resumen test',
      embedding: dummy1024,
      ingestStatus: 'ready',
    }).returning({ id: contents.id });

    const [ev] = await drizzleDb.insert(evaluations).values({
      contentId: c.id,
      projectSnapshotId: snap.id,
      verdict: 'actionable',
      consumptionSeq: 1,
    }).returning({ id: evaluations.id });

    await drizzleDb.insert(actionSuggestions).values({
      evaluationId: ev.id,
      projectId,
      contentId: c.id,
      actionType: 'evidence_citation',
      observation: 'Observación test',
      suggestedAction: 'Acción test',
      targetFile: 'project.md',
      status: 'pending',
    });

    // 5. Load Server
    const serverModule = await import('../src/api/server');
    server = serverModule.server;
    await server.ready();
  }, 120000);

  afterAll(async () => {
    const { stopVaultWatcher } = await import('../src/vault/watcher');
    await stopVaultWatcher();

    const { pool } = await import('../src/db/index');
    await pool.end();
    if (container) await container.stop();

    try {
      await fs.rm(vaultA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await fs.rm(vaultB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore lock on cleanup
    }
    vi.restoreAllMocks();
  });

  it('GET /api/settings/vault devuelve estado de vault configurado y proyectos existentes', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/settings/vault',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.isConfigured).toBe(true);
    expect(body.isValid).toBe(true);
    expect(body.hasProjectsDir).toBe(true);
    expect(body.projects.length).toBeGreaterThanOrEqual(1);

    const aiAgentProj = body.projects.find((p: any) => p.folderPath === 'Projects/AI_Agents');
    expect(aiAgentProj).toBeDefined();
    expect(aiAgentProj.existsOnDisk).toBe(true);
    expect(aiAgentProj.isActive).toBe(true);
    expect(aiAgentProj.suggestionsCount).toBe(1);
  });

  it('POST /api/settings/vault rechaza rutas inexistentes con error 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vault',
      payload: {
        vaultPath: 'C:\\NonExistent\\Path\\To\\Vault_123456789',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('no existe o no es un directorio válido');
  });

  it('POST /api/settings/vault cambia al Vault B: proyecto ausente se desactiva pero conserva sugerencias', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vault',
      payload: {
        vaultPath: vaultB,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.hasProjectsDir).toBe(true);

    // AI_Agents no está en Vault B -> debe estar marcado inactivo y existsOnDisk = false
    const aiAgents = body.projects.find((p: any) => p.folderPath === 'Projects/AI_Agents');
    expect(aiAgents).toBeDefined();
    expect(aiAgents.existsOnDisk).toBe(false);
    expect(aiAgents.isActive).toBe(false);

    // Data_Pipelines es nuevo en Vault B -> debe existir y estar activo
    const dataPipelines = body.projects.find((p: any) => p.folderPath === 'Projects/Data_Pipelines');
    expect(dataPipelines).toBeDefined();
    expect(dataPipelines.existsOnDisk).toBe(true);
    expect(dataPipelines.isActive).toBe(true);

    // Verificar en DB que la sugerencia de AI_Agents sigue intacta
    const { db: drizzleDb } = await import('../src/db/index');
    const { actionSuggestions } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const sugs = await drizzleDb.select().from(actionSuggestions).where(eq(actionSuggestions.projectId, projectId));
    expect(sugs.length).toBe(1);
  }, 30000);

  it('POST /api/settings/vault regresa al Vault A: AI_Agents se reactiva automáticamente', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vault',
      payload: {
        vaultPath: vaultA,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const aiAgents = body.projects.find((p: any) => p.folderPath === 'Projects/AI_Agents');
    expect(aiAgents).toBeDefined();
    expect(aiAgents.existsOnDisk).toBe(true);
    expect(aiAgents.isActive).toBe(true);
  }, 30000);

  it('POST /api/settings/vault/rescan ejecuta re-escaneo sobre el vault activo', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vault/rescan',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.projects.length).toBeGreaterThanOrEqual(1);
  });

  it('Opción A: contenido consumido mientras el proyecto estuvo inactivo es detectado en backlog al reactivar', async () => {
    const { db: drizzleDb } = await import('../src/db/index');
    const { contents, projectSnapshots } = await import('../src/db/schema');
    const { eq, desc, and, isNotNull } = await import('drizzle-orm');
    const { findBacklogUnevaluatedContents, evaluateContentMatch } = await import('../src/evaluator');

    // Obtener el snapshot más reciente y activo de AI_Agents
    const [latestSnap] = await drizzleDb.select()
      .from(projectSnapshots)
      .where(and(eq(projectSnapshots.projectId, projectId), isNotNull(projectSnapshots.embedding)))
      .orderBy(desc(projectSnapshots.capturedAt))
      .limit(1);

    expect(latestSnap).toBeDefined();

    // Simular un contenido consumido mientras AI_Agents no estaba activo, con vector relevante
    const [backlogContent] = await drizzleDb.insert(contents).values({
      uri: 'https://example.com/backlog-agents-guide',
      title: 'Guía de Agentes Distribuidos',
      summary: 'Patrones avanzados para sistemas de agentes autónomos distribuidos.',
      embedding: latestSnap.embedding,
      ingestStatus: 'ready',
    }).returning({ id: contents.id });

    // Verificar que findBacklogUnevaluatedContents detecta este contenido pendiente
    const pendingIds = await findBacklogUnevaluatedContents(projectId);
    expect(pendingIds).toContain(backlogContent.id);

    // Ejecutar la evaluación dirigida
    await evaluateContentMatch(backlogContent.id, projectId);

    // Tras la evaluación, ya no debe figurar como pendiente
    const pendingAfter = await findBacklogUnevaluatedContents(projectId);
    expect(pendingAfter).not.toContain(backlogContent.id);
  }, 30000);
});
