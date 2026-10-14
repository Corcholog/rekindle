import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Phase 7: Web UI API & Static Serving Integration Tests', () => {
  let container: any;
  let vaultPath: string;
  let server: any;
  let content1Id: string;
  let content2Id: string;
  let projectId: string;
  let suggestionId: string;

  beforeAll(async () => {
    // 1. Setup Test DB
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('loomdb_phase7')
      .withUsername('tester')
      .withPassword('testpass')
      .start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    // 2. Create Dummy Vault
    vaultPath = path.join(__dirname, 'DummyVault_Phase7');
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
    const [snap] = await drizzleDb.insert(projectSnapshots).values({
      projectId,
      treeHash: 'snap-hash-777',
      thesisText: 'Agentes autónomos con eventos Pub/Sub.',
    }).returning({ id: projectSnapshots.id });

    // Seed Content 1 (Ready)
    const [c1] = await drizzleDb.insert(contents).values({
      uri: 'https://techblog.com/agents-guide',
      title: 'Guía de Agentes Autónomos',
      summary: 'Resumen completo sobre arquitectura de agentes y patrones distribuidos.',
      ingestStatus: 'ready',
    }).returning({ id: contents.id });
    content1Id = c1.id;

    // Seed Content 2 (Failed)
    const [c2] = await drizzleDb.insert(contents).values({
      uri: 'https://badsite.com/offline',
      title: 'Página inaccesible',
      ingestStatus: 'failed',
      ingestStatusReason: 'Failed to fetch URL: 404 Not Found',
    }).returning({ id: contents.id });
    content2Id = c2.id;

    // Seed Evaluation
    const [ev] = await drizzleDb.insert(evaluations).values({
      contentId: content1Id,
      projectSnapshotId: snap.id,
      verdict: 'actionable',
      confidenceScore: 0.92,
      triageReasoning: 'Alineado con el ecosistema de microservicios para agentes.',
      consumptionSeq: 1,
    }).returning({ id: evaluations.id });

    // Seed Suggestion
    const [sug] = await drizzleDb.insert(actionSuggestions).values({
      evaluationId: ev.id,
      projectId,
      contentId: content1Id,
      actionType: 'evidence_citation',
      observation: 'Valida la elección de broker.',
      suggestedAction: 'Citar en el capítulo 2.',
      targetFile: 'architecture.md',
      status: 'pending',
      writtenToVault: false,
    }).returning({ id: actionSuggestions.id });
    suggestionId = sug.id;

    // 5. Load API Server
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
      // Ignore temporary locks on cleanup
    }
    vi.restoreAllMocks();
  });

  it('GET / sirve la aplicación web estática (index.html)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('Loom');
    expect(res.payload).toContain('Consumo');
    expect(res.payload).toContain('Sugerencias');
  });

  it('GET /styles.css sirve la hoja de estilos de la interfaz', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/styles.css',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.payload).toContain('--bg-primary');
  });

  it('GET /app.js sirve la lógica cliente de la interfaz', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/app.js',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.payload).toContain('loadContents');
  });

  it('GET /api/contents lista contenidos procesados con conteos', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/contents',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);

    const readyItem = body.items.find((i: any) => i.id === content1Id);
    expect(readyItem).toBeDefined();
    expect(readyItem.ingestStatus).toBe('ready');
    expect(readyItem.counts.evaluations).toBe(1);
    expect(readyItem.counts.actionable).toBe(1);
    expect(readyItem.counts.suggestions).toBe(1);

    const failedItem = body.items.find((i: any) => i.id === content2Id);
    expect(failedItem).toBeDefined();
    expect(failedItem.ingestStatus).toBe('failed');
    expect(failedItem.ingestStatusReason).toContain('404');
  });

  it('GET /api/contents?status=failed filtra correctamente', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/contents?status=failed',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(content2Id);
  });

  it('GET /api/contents/:id retorna detalle enriquecido con evaluaciones por proyecto', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/contents/${content1Id}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.id).toBe(content1Id);
    expect(body.summary).toContain('Resumen completo');
    expect(body.evaluations).toHaveLength(1);
    expect(body.evaluations[0].projectTitle).toBe('Proyecto: AI Agents');
    expect(body.evaluations[0].verdict).toBe('actionable');
  });

  it('GET /api/contents/:id retorna 404 para ID inexistente', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/contents/00000000-0000-0000-0000-000000000000',
    });

    expect(res.statusCode).toBe(404);
  });

  it('PATCH /api/suggestions/:id idempotencia: re-aceptar no duplica en Obsidian', async () => {
    // 1. Primera aceptación
    const res1 = await server.inject({
      method: 'PATCH',
      url: `/api/suggestions/${suggestionId}`,
      payload: { status: 'accepted', userFeedback: 'Confirmado para marco teórico.' },
    });
    expect(res1.statusCode).toBe(200);

    const suggestionsMdPath = path.join(vaultPath, 'Projects', 'AI_Agents', 'suggestions.md');
    const contentFirst = await fs.readFile(suggestionsMdPath, 'utf-8');
    const matchesFirst = contentFirst.match(/\[!tip\]/g);
    expect(matchesFirst).toHaveLength(1);

    // 2. Segunda aceptación idéntica (idempotente)
    const res2 = await server.inject({
      method: 'PATCH',
      url: `/api/suggestions/${suggestionId}`,
      payload: { status: 'accepted' },
    });
    expect(res2.statusCode).toBe(200);

    const contentSecond = await fs.readFile(suggestionsMdPath, 'utf-8');
    const matchesSecond = contentSecond.match(/\[!tip\]/g);
    // Debe tener exactamente 1 callout, SIN duplicación
    expect(matchesSecond).toHaveLength(1);
  });

  it('PATCH /api/suggestions/:id rechaza conflicto (409) si ya fue resuelta en otro estado', async () => {
    // Intentar cambiar una sugerencia ya aceptada a 'discarded'
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/suggestions/${suggestionId}`,
      payload: { status: 'discarded' },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('Conflict');
    expect(body.message).toContain("already resolved as 'accepted'");
  });

  it('Resuelve evaluaciones tentativas sin mutar evaluations.verdict ni generar duplicados zombies (K1)', async () => {
    const { db: drizzleDb } = await import('../src/db/index');
    const { evaluations, actionSuggestions } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');

    // 1. Seed a tentative evaluation
    const [evTentative] = await drizzleDb.insert(evaluations).values({
      contentId: content1Id,
      projectSnapshotId: (await drizzleDb.query.projectSnapshots.findFirst())!.id,
      verdict: 'tentative',
      confidenceScore: 0.55,
      triageReasoning: 'Relación tentativa sobre microservicios.',
      consumptionSeq: 2,
    }).returning({ id: evaluations.id });

    // 2. Before resolution: must appear in active suggestions
    const beforeRes = await server.inject({
      method: 'GET',
      url: '/api/suggestions?status=active',
    });
    expect(beforeRes.statusCode).toBe(200);
    const beforeBody = JSON.parse(beforeRes.payload);
    expect(beforeBody.items.some((i: any) => i.id === evTentative.id)).toBe(true);

    // 3. User discards the tentative suggestion
    const patchRes = await server.inject({
      method: 'PATCH',
      url: `/api/suggestions/${evTentative.id}`,
      payload: { status: 'discarded', userFeedback: 'No aplica para este sprint' },
    });
    expect(patchRes.statusCode).toBe(200);

    // 4. Verify evaluations.verdict was NOT mutated to 'irrelevant' (immutable history)
    const [evInDb] = await drizzleDb.select().from(evaluations).where(eq(evaluations.id, evTentative.id));
    expect(evInDb.verdict).toBe('tentative');

    // 5. Verify action_suggestions has recorded the user decision
    const sugInDb = await drizzleDb.query.actionSuggestions.findFirst({
      where: eq(actionSuggestions.evaluationId, evTentative.id),
    });
    expect(sugInDb).toBeDefined();
    expect(sugInDb!.status).toBe('discarded');

    // 6. After resolution: must NOT appear in active suggestions (no zombie duplicate)
    const afterRes = await server.inject({
      method: 'GET',
      url: '/api/suggestions?status=active',
    });
    const afterBody = JSON.parse(afterRes.payload);
    expect(afterBody.items.some((i: any) => i.id === evTentative.id)).toBe(false);

    // 7. Must appear in discarded suggestions
    const discardedRes = await server.inject({
      method: 'GET',
      url: '/api/suggestions?status=discarded',
    });
    const discardedBody = JSON.parse(discardedRes.payload);
    expect(discardedBody.items.some((i: any) => i.evaluationId === evTentative.id || i.id === sugInDb!.id)).toBe(true);
  });

  it('POST /api/ingest rechaza URLs privadas o loopback protegiendo contra SSRF (K4)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/ingest',
      payload: { url: 'http://127.0.0.1:5432/secrets' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('direcciones locales o privadas no permitidas');
  });

  it('POST /api/settings/vault rechaza peticiones cross-origin no autorizadas (K4)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vault',
      headers: {
        origin: 'https://malicious-website.com',
      },
      payload: { vaultPath: 'C:\\Users\\victim\\Documents' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('Forbidden');
  });

  it('Reconcilia proyectos sin project.md con notas libres y en subcarpetas', async () => {
    const { reconcileProject } = await import('../src/vault/reconciler');
    const { projects, projectSnapshots } = await import('../src/db/schema');
    const { db: drizzleDb } = await import('../src/db/index');
    const { eq } = await import('drizzle-orm');

    // 1. Create a project folder with multiple arbitrary notes and a subfolder, NO project.md
    const customProjPath = path.join(vaultPath, 'Projects', 'Brainstorming_Project');
    await fs.mkdir(path.join(customProjPath, 'research'), { recursive: true });

    await fs.writeFile(
      path.join(customProjPath, 'ideas.md'),
      '# Ideas Principales\nLluvia de ideas inicial sobre diseño de videojuegos.',
      'utf-8'
    );
    await fs.writeFile(
      path.join(customProjPath, 'research', 'mechanics.md'),
      '# Mecánicas de Juego\nAnálisis de mecánicas de decisión y consecuencias.',
      'utf-8'
    );

    // 2. Reconcile project
    await reconcileProject(customProjPath, vaultPath, true);

    // 3. Verify in DB
    const [p] = await drizzleDb.select().from(projects).where(eq(projects.folderPath, 'Projects/Brainstorming_Project'));
    expect(p).toBeDefined();
    expect(p.isActive).toBe(true);

    const snapshots = await drizzleDb.select().from(projectSnapshots).where(eq(projectSnapshots.projectId, p.id));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0].noteTitles).toContain('Ideas Principales');
    expect(snapshots[0].noteTitles).toContain('Mecánicas de Juego');
    expect(snapshots[0].notesContent).toContain('Lluvia de ideas');
    expect(snapshots[0].notesContent).toContain('mecánicas de decisión');
  });
});
