import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Phase 6: Suggestion Lifecycle & Feedback API', () => {
  let container: any;
  let vaultPath: string;
  let server: any;
  let projectId: string;
  let contentId: string;
  let evalId: string;
  let suggestion1Id: string;
  let suggestion2Id: string;

  beforeAll(async () => {
    // 1. Setup Test DB
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('rekindledb_phase6')
      .withUsername('tester')
      .withPassword('testpass')
      .start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    // 2. Create Dummy Vault
    vaultPath = path.join(__dirname, 'DummyVault_Phase6');
    await fs.mkdir(path.join(vaultPath, 'Projects', 'AI_Agents'), { recursive: true });
    vi.stubEnv('VAULT_PATH', vaultPath);

    // 3. Init DB schema
    const { pool, db: drizzleDb } = await import('../src/db/index');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(drizzleDb, { migrationsFolder: './drizzle' });

    // 4. Seed Data
    const { projects, projectSnapshots, contents, evaluations, actionSuggestions } = await import('../src/db/schema');

    // Seed Project
    const [proj] = await drizzleDb.insert(projects).values({
      folderPath: 'Projects/AI_Agents',
      title: 'Proyecto: AI Agents',
    }).returning({ id: projects.id });
    projectId = proj.id;

    // Seed Snapshot
    await drizzleDb.insert(projectSnapshots).values({
      projectId,
      treeHash: 'testhash123',
      thesisText: 'Construir agentes autónomos con arquitectura Pub/Sub.',
      noteTitles: ['ideas.md', 'architecture.md'],
    });

    // Seed Content
    const [cont] = await drizzleDb.insert(contents).values({
      uri: 'https://techblog.com/pub-sub-ai',
      title: 'El poder de Pub/Sub en Sistemas Distribuidos',
      summary: 'Resumen técnico sobre agentes y desacoplamiento usando brokers de mensajes.',
      ingestStatus: 'ready',
    }).returning({ id: contents.id });
    contentId = cont.id;

    // Seed Evaluation
    const [ev] = await drizzleDb.insert(evaluations).values({
      contentId,
      projectSnapshotId: (await drizzleDb.select().from(projectSnapshots))[0].id,
      verdict: 'actionable',
      confidenceScore: 0.95,
      triageReasoning: 'Valida directamente la tesis de comunicación de agentes.',
      consumptionSeq: 1,
    }).returning({ id: evaluations.id });
    evalId = ev.id;

    // Seed 2 Suggestions
    const [s1] = await drizzleDb.insert(actionSuggestions).values({
      evaluationId: evalId,
      projectId,
      contentId,
      actionType: 'evidence_citation',
      observation: 'El artículo valida la elección de Pub/Sub para agentes.',
      suggestedAction: 'Citar este artículo en la sección de arquitectura del proyecto.',
      targetFile: 'architecture.md',
      status: 'pending',
      writtenToVault: false,
    }).returning({ id: actionSuggestions.id });
    suggestion1Id = s1.id;

    // Each evaluation yields at most one suggestion, so the second one gets its own evaluation
    const [ev2] = await drizzleDb.insert(evaluations).values({
      contentId,
      projectSnapshotId: (await drizzleDb.select().from(projectSnapshots))[0].id,
      verdict: 'actionable',
      confidenceScore: 0.8,
      triageReasoning: 'Aporta un contraargumento sobre particionamiento.',
      consumptionSeq: 2,
    }).returning({ id: evaluations.id });

    const [s2] = await drizzleDb.insert(actionSuggestions).values({
      evaluationId: ev2.id,
      projectId,
      contentId,
      actionType: 'counter_argument',
      observation: 'Presenta posibles cuellos de botella en brokers sin partición.',
      suggestedAction: 'Evaluar estrategias de particionamiento para evitar latencia.',
      targetFile: 'architecture.md',
      status: 'pending',
      writtenToVault: false,
    }).returning({ id: actionSuggestions.id });
    suggestion2Id = s2.id;

    // 5. Load API server
    const serverModule = await import('../src/api/server');
    server = serverModule.server;
    await server.ready();
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    if (container) await container.stop();
    try {
      await fs.rm(vaultPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore Windows temporary locks on cleanup
    }
    vi.restoreAllMocks();
  });

  it('GET /api/projects retorna la lista de proyectos con tesis y contadores', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/projects',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.projects).toHaveLength(1);
    
    const p = body.projects[0];
    expect(p.id).toBe(projectId);
    expect(p.title).toBe('Proyecto: AI Agents');
    expect(p.thesisText).toContain('Pub/Sub');
    expect(p.counts).toMatchObject({
      pending: 2,
      accepted: 0,
      discarded: 0,
      total: 2,
    });
  });

  it('GET /api/suggestions lista sugerencias pendientes con paginación y filtros', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/suggestions?projectId=${projectId}&status=pending`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].projectTitle).toBe('Proyecto: AI Agents');
    expect(body.items[0].contentTitle).toBe('El poder de Pub/Sub en Sistemas Distribuidos');
  });

  it('GET /api/suggestions/:id retorna el detalle enriquecido con evaluación', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/suggestions/${suggestion1Id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.id).toBe(suggestion1Id);
    expect(body.triageVerdict).toBe('actionable');
    expect(body.confidenceScore).toBe(0.95);
    expect(body.contentSummary).toContain('Resumen técnico');
  });

  it('PATCH /api/suggestions/:id (ACCEPTED) actualiza estado y escribe Callout en Obsidian Vault', async () => {
    const response = await server.inject({
      method: 'PATCH',
      url: `/api/suggestions/${suggestion1Id}`,
      payload: {
        status: 'accepted',
        userFeedback: 'Excelente referencia para fundamentar el broker.',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.status).toBe('accepted');
    expect(body.userFeedback).toBe('Excelente referencia para fundamentar el broker.');
    expect(body.resolvedAt).not.toBeNull();
    expect(body.writtenToVault).toBe(true);

    // Verificar en el sistema de archivos de Obsidian
    const suggestionsMdPath = path.join(vaultPath, 'Projects', 'AI_Agents', 'suggestions.md');
    const content = await fs.readFile(suggestionsMdPath, 'utf-8');
    
    console.log('\n📄 CONTENIDO GENERADO EN OBSIDIAN POR ACEPTACIÓN:');
    expect(content).toContain('> [!tip] Sugerencia Aceptada: CITA DE EVIDENCIA');
    expect(content).toContain('Citar este artículo en la sección de arquitectura del proyecto.');
    expect(content).toContain('Excelente referencia para fundamentar el broker.');
  });

  it('PATCH /api/suggestions/:id (DISCARDED) actualiza estado sin escribir en el Vault', async () => {
    const response = await server.inject({
      method: 'PATCH',
      url: `/api/suggestions/${suggestion2Id}`,
      payload: {
        status: 'discarded',
        userFeedback: 'No aplica a esta etapa del proyecto.',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.status).toBe('discarded');
    expect(body.userFeedback).toBe('No aplica a esta etapa del proyecto.');

    // Verificar que el callout de la sugerencia 2 NO se escribió en el vault
    const suggestionsMdPath = path.join(vaultPath, 'Projects', 'AI_Agents', 'suggestions.md');
    const content = await fs.readFile(suggestionsMdPath, 'utf-8');
    expect(content).not.toContain('COUNTER ARGUMENT');
  });

  it('GET /api/projects refleja los nuevos conteos tras aceptar y descartar', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/projects',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    const project = body.projects.find((p: { id: string }) => p.id === projectId);
    expect(project.counts).toMatchObject({
      pending: 0,
      accepted: 1,
      discarded: 1,
      total: 2,
    });
  });

  it('PATCH /api/suggestions/:id valida status inválido', async () => {
    const response = await server.inject({
      method: 'PATCH',
      url: `/api/suggestions/${suggestion1Id}`,
      payload: {
        status: 'invalid_status',
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
