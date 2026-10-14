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

    // 4. Verify hierarchical note-level snapshots are populated
    const { projectNoteSnapshots } = await import('../src/db/schema');
    const noteSnapshots = await drizzleDb.select().from(projectNoteSnapshots).where(eq(projectNoteSnapshots.projectSnapshotId, snapshots[0].id));
    expect(noteSnapshots.length).toBe(2);

    const ideasNote = noteSnapshots.find(n => n.notePath === 'ideas.md');
    const mechanicsNote = noteSnapshots.find(n => n.notePath.includes('mechanics.md'));
    expect(ideasNote).toBeDefined();
    expect(ideasNote!.embedding).toBeDefined();
    expect(ideasNote!.embedding!.length).toBe(1024);
    expect(mechanicsNote).toBeDefined();
    expect(mechanicsNote!.embedding).toBeDefined();
    expect(mechanicsNote!.embedding!.length).toBe(1024);
  });

  it('Hierarchical note-level embeddings detect focal note and resolve targetFile in evaluations', async () => {
    const { db: drizzleDb } = await import('../src/db/index');
    const { projects, projectSnapshots, projectNoteSnapshots, contents, actionSuggestions } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const { evaluateContentMatch, findBacklogUnevaluatedContents } = await import('../src/evaluator');

    const [p] = await drizzleDb.select().from(projects).where(eq(projects.folderPath, 'Projects/Brainstorming_Project'));
    expect(p).toBeDefined();

    const [snap] = await drizzleDb.select().from(projectSnapshots).where(eq(projectSnapshots.projectId, p.id));
    expect(snap).toBeDefined();

    const noteSnapshots = await drizzleDb.select().from(projectNoteSnapshots).where(eq(projectNoteSnapshots.projectSnapshotId, snap.id));
    const mechanicsNote = noteSnapshots.find(n => n.notePath.includes('mechanics.md'));
    expect(mechanicsNote).toBeDefined();
    expect(mechanicsNote!.embedding).toBeDefined();

    // 1. Insert an ingested content with vector identical to mechanics.md
    const [content] = await drizzleDb.insert(contents).values({
      uri: 'https://gamestudies.org/mechanics-in-narrative',
      title: 'Mecánicas y Consecuencias en Juegos de Rol',
      summary: 'Estudio sobre cómo los árboles de consecuencias y decisiones refuerzan la inmersión del jugador.',
      embedding: mechanicsNote!.embedding,
      ingestStatus: 'ready',
    }).returning({ id: contents.id });

    // 2. Verify findBacklogUnevaluatedContents finds this content via note snapshot matching
    const backlogIds = await findBacklogUnevaluatedContents(p.id);
    expect(backlogIds).toContain(content.id);

    // 3. Mock ollama.evaluateContent so it returns an actionable verdict without needing actual LLM network
    const { sharedAiProvider } = await import('../src/ai/OllamaProvider');
    const evaluateSpy = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValueOnce({
      data: {
        verdict: 'actionable',
        confidenceScore: 0.95,
        triageReasoning: 'Aporta teoría clave sobre consecuencias para el diseño de mecánicas.',
        action: {
          actionType: 'evidence_citation',
          observation: 'Explica modelos de decisión aplicables.',
          suggestedAction: 'Citar en la sección de árboles de decisión.',
          // targetFile omitted so evaluator resolves it to matchedNotePath
        },
      },
      model: 'mock-llm',
    });

    // 4. Run Step 1 + Step 2 evaluation
    await evaluateContentMatch(content.id, p.id);

    // 5. Verify action suggestion was created with targetFile resolved to mechanics.md and not 'unknown'
    const suggestions = await drizzleDb.select().from(actionSuggestions).where(eq(actionSuggestions.contentId, content.id));
    expect(suggestions.length).toBe(1);
    expect(suggestions[0].targetFile).toBe(mechanicsNote!.notePath);
    expect(suggestions[0].targetFile).not.toBe('unknown');

    evaluateSpy.mockRestore();
  });

  it('Feature 2: OPTIONS /api/ingest responde preflight CORS para bookmarklet y extensiones', async () => {
    const res = await server.inject({
      method: 'OPTIONS',
      url: '/api/ingest',
      headers: {
        origin: 'https://news.ycombinator.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('Feature 2: POST /api/ingest acepta title y selection desde Web Clipper y almacena metadatos', async () => {
    const { db: drizzleDb } = await import('../src/db/index');
    const { contents } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const { boss } = await import('../src/queue/index');
    const bossSpy = vi.spyOn(boss, 'send').mockResolvedValue('mock-job-id');

    const testUrl = 'https://arstechnica.com/science/2026/quantum-leap';
    const res = await server.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: {
        origin: 'chrome-extension://abcdefghijklmno',
      },
      payload: {
        url: testUrl,
        title: 'Avance en Computación Cuántica',
        selection: 'Un nuevo método de corrección de errores reduce el ruido en un 99%.',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const body = JSON.parse(res.payload);
    expect(body.contentId).toBeDefined();

    // Verify metadata stored in DB
    const [c] = await drizzleDb.select().from(contents).where(eq(contents.id, body.contentId));
    expect(c).toBeDefined();
    expect(c.title).toBe('Avance en Computación Cuántica');
    expect(c.rawText).toBe('Un nuevo método de corrección de errores reduce el ruido en un 99%.');

    expect(bossSpy).toHaveBeenCalledWith('ingest_url', expect.objectContaining({
      contentId: body.contentId,
      url: testUrl,
      initialTitle: 'Avance en Computación Cuántica',
      selection: 'Un nuevo método de corrección de errores reduce el ruido en un 99%.',
    }), expect.any(Object));

    bossSpy.mockRestore();
  });

  it('Feature 2: Extensión Web Clipper cuenta con manifest V3 e iconos reales de pixel exacto', async () => {
    const extensionDir = path.resolve(__dirname, '../extension');
    const manifestPath = path.join(extensionDir, 'manifest.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Loom Web Clipper');
    expect(manifest.action.default_popup).toBe('popup.html');
    expect(manifest.background.service_worker).toBe('background.js');

    // Verify icons exist and have valid size
    for (const [sizeStr, iconPath] of Object.entries(manifest.icons)) {
      const fullIconPath = path.join(extensionDir, iconPath as string);
      const stat = await fs.stat(fullIconPath);
      expect(stat.size).toBeGreaterThan(0);
    }
  });

  it('Feature 2: Frontend sirve markup del Bookmarklet arrastrable y modal de instalación', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/index.html',
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('id="bookmarklet-btn"');
    expect(res.payload).toContain('id="btn-copy-bookmarklet"');
    expect(res.payload).toContain('id="extension-guide-modal"');
    expect(res.payload).toContain('c:\\Projects\\loom\\extension');
  });

  it('Feature 3: GET /api/library/search realiza búsqueda semántica vectorial sobre contenidos listos', async () => {
    const { sharedAiProvider } = await import('../src/ai/OllamaProvider');
    const { db: drizzleDb } = await import('../src/db/index');
    const { contents } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');

    // Retrieve mechanics note vector from previous test or content1
    const [c1] = await drizzleDb.select().from(contents).where(eq(contents.id, content1Id));
    expect(c1).toBeDefined();

    const embedSpy = vi.spyOn(sharedAiProvider, 'getEmbedding').mockResolvedValueOnce(new Array(1024).fill(0.05));

    const res = await server.inject({
      method: 'GET',
      url: '/api/library/search?q=agentes%20autonomos&limit=5',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.query).toBe('agentes autonomos');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].id).toBeDefined();
    expect(body.results[0].similarityScore).toBeGreaterThanOrEqual(0);

    embedSpy.mockRestore();
  });

  it('Feature 3: POST /api/library/ask sintetiza respuesta RAG con citas directas [1], [2]', async () => {
    const { sharedAiProvider } = await import('../src/ai/OllamaProvider');
    const { db: drizzleDb } = await import('../src/db/index');
    const { contents } = await import('../src/db/schema');
    const { eq, and, isNotNull } = await import('drizzle-orm');

    const [readyContent] = await drizzleDb.select().from(contents)
      .where(and(eq(contents.ingestStatus, 'ready'), isNotNull(contents.embedding)))
      .limit(1);
    expect(readyContent).toBeDefined();
    expect(readyContent.embedding).toBeDefined();

    const embedSpy = vi.spyOn(sharedAiProvider, 'getEmbedding').mockResolvedValueOnce(readyContent.embedding!);
    const evalSpy = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValueOnce({
      data: {
        answer: 'Los agentes autónomos utilizan arquitecturas orientadas a eventos y brokers pub/sub [1] para coordinar tareas complejas.',
        keyInsights: [
          'El desacoplamiento por eventos previene cuellos de botella.',
          'Permite escalabilidad horizontal en microservicios.',
        ],
      },
      model: 'mock-llm',
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/library/ask',
      payload: {
        query: '¿Cómo se coordinan los agentes autónomos?',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.answer).toContain('[1]');
    expect(body.keyInsights.length).toBe(2);
    expect(body.sources.length).toBeGreaterThanOrEqual(1);
    expect(body.sources[0].index).toBe(1);

    embedSpy.mockRestore();
    evalSpy.mockRestore();
  });

  it('Feature 3: Frontend sirve interfaz de búsqueda semántica y síntesis de biblioteca', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/index.html',
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('id="library-query-form"');
    expect(res.payload).toContain('id="btn-mode-search"');
    expect(res.payload).toContain('id="btn-mode-ask"');
    expect(res.payload).toContain('id="library-results-box"');
  });

  it('Feature 4: POST /api/projects/:id/synthesize retorna 404 para proyecto inexistente', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects/00000000-0000-0000-0000-000000000000/synthesize',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('Not Found');
  });

  it('Feature 4: POST /api/projects/:id/synthesize retorna 400 si el proyecto no tiene sugerencias aceptadas', async () => {
    const { projects } = await import('../src/db/schema');
    const { db: drizzleDb } = await import('../src/db/index');

    const [emptyProj] = await drizzleDb.insert(projects).values({
      folderPath: 'Projects/Empty_Research',
      title: 'Proyecto Vacío',
    }).returning({ id: projects.id });

    const res = await server.inject({
      method: 'POST',
      url: `/api/projects/${emptyProj.id}/synthesize`,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('Bad Request');
    expect(body.message).toContain('No hay sugerencias aceptadas');
  });

  it('Feature 4: POST /api/projects/:id/synthesize compila research_brief.md cuando existen sugerencias aceptadas', async () => {
    const { actionSuggestions } = await import('../src/db/schema');
    const { db: drizzleDb } = await import('../src/db/index');
    const { eq } = await import('drizzle-orm');
    const { sharedAiProvider } = await import('../src/ai/OllamaProvider');

    // Accept suggestion
    await drizzleDb.update(actionSuggestions)
      .set({ status: 'accepted', resolvedAt: new Date() })
      .where(eq(actionSuggestions.id, suggestionId));

    const evalSpy = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValueOnce({
      data: {
        title: 'Síntesis de Investigación: AI Agents',
        executiveSummary: 'Compilación estructurada de arquitecturas orientadas a eventos para coordinar agentes autónomos.',
        markdownContent: '## Arquitectura Base\nSe recomienda desacoplamiento mediante colas de mensajería asíncronas [[AI_Agents]].',
        suggestedNextSteps: ['Evaluar throughput de eventos', 'Diseñar contratos protobuf'],
      },
      model: 'mock-llm',
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/synthesize`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.filePath).toBe('research_brief.md');
    expect(body.title).toBe('Síntesis de Investigación: AI Agents');
    expect(body.executiveSummary).toContain('Compilación estructurada');
    expect(body.acceptedCount).toBeGreaterThanOrEqual(1);
    expect(body.writtenToVault).toBe(true);

    // Verify file on disk in Vault
    const briefDiskPath = path.join(vaultPath, 'Projects', 'AI_Agents', 'research_brief.md');
    const fileExists = await fs.access(briefDiskPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);
    const fileContent = await fs.readFile(briefDiskPath, 'utf-8');
    expect(fileContent).toContain('type: research_brief');
    expect(fileContent).toContain('# Síntesis de Investigación: AI Agents');

    evalSpy.mockRestore();
  });

  it('Feature 4: Frontend sirve botón de síntesis y modal en index.html', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/index.html',
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('id="btn-synthesize-project"');
    expect(res.payload).toContain('id="synthesis-result-modal"');
    expect(res.payload).toContain('id="synthesis-modal-title"');
  });

  it('Feature 5: GET /api/projects/synergies detecta sinergias y puentes semánticos entre proyectos activos', async () => {
    const { projects, projectSnapshots, projectNoteSnapshots } = await import('../src/db/schema');
    const { db: drizzleDb } = await import('../src/db/index');
    const { eq } = await import('drizzle-orm');

    // Create a second active project with snapshot & note
    const [projB] = await drizzleDb.insert(projects).values({
      folderPath: 'Projects/Vector_Databases',
      title: 'Bases de Datos Vectoriales',
      isActive: true,
    }).returning({ id: projects.id });

    // Seed snapshot for Project B with vector close to AI_Agents
    const vectorB = new Array(1024).fill(0.05);
    const [snapB] = await drizzleDb.insert(projectSnapshots).values({
      projectId: projB.id,
      treeHash: 'hash-snap-b',
      thesisText: 'Indexación vectorial HNSW y búsqueda semántica de alta velocidad.',
      embedding: vectorB,
    }).returning({ id: projectSnapshots.id });

    // Update Project A's snapshot with vector
    const vectorA = new Array(1024).fill(0.052);
    await drizzleDb.update(projectSnapshots)
      .set({ embedding: vectorA })
      .where(eq(projectSnapshots.projectId, projectId));

    // Seed note snapshots for both projects
    await drizzleDb.insert(projectNoteSnapshots).values([
      {
        projectId,
        projectSnapshotId: snapB.id, // reference valid snap
        noteTitle: 'Arquitectura de Agentes',
        notePath: 'Projects/AI_Agents/architecture.md',
        contentSnippet: 'Coordinación de agentes pub/sub y memoria distribuida.',
        embedding: vectorA,
      },
      {
        projectId: projB.id,
        projectSnapshotId: snapB.id,
        noteTitle: 'Índices HNSW',
        notePath: 'Projects/Vector_Databases/hnsw_indexes.md',
        contentSnippet: 'Algoritmos de grafos para recuperación eficiente de vectores.',
        embedding: vectorB,
      },
    ]);

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects/synergies?minSimilarity=20&limit=10',
    });

    if (res.statusCode !== 200) {
      console.error('GET /api/projects/synergies returned:', res.statusCode, res.payload);
    }
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.synergies).toBeDefined();
    expect(body.totalCount).toBeGreaterThanOrEqual(1);

    const synergy = body.synergies.find((s: any) =>
      (s.projectA.id === projectId && s.projectB.id === projB.id) ||
      (s.projectB.id === projectId && s.projectA.id === projB.id)
    );

    expect(synergy).toBeDefined();
    expect(synergy.similarityScore).toBeGreaterThanOrEqual(80);
    expect(synergy.rationale).toContain('Afinidad conceptual detectada');
    expect(synergy.closestNotes.length).toBeGreaterThanOrEqual(1);
  });

  it('Feature 5: POST /api/projects/synergies/explore genera nota puente en el Vault', async () => {
    const { projects } = await import('../src/db/schema');
    const { db: drizzleDb } = await import('../src/db/index');
    const { eq } = await import('drizzle-orm');
    const { sharedAiProvider } = await import('../src/ai/OllamaProvider');

    const [projB] = await drizzleDb.select().from(projects).where(eq(projects.folderPath, 'Projects/Vector_Databases'));
    expect(projB).toBeDefined();

    const evalSpy = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValueOnce({
      data: {
        bridgeTitle: 'Puente Conceptual: Agentes y Memoria Vectorial',
        overview: 'Conexión simbiótica entre la reactividad de agentes autónomos y la persistencia contextual de índices vectoriales.',
        sharedProblems: [
          'Gestión de latencia en consultas RAG multi-agente.',
          'Consistencia eventual del grafo de memoria.',
        ],
        mutualBenefits: [
          'Los agentes se nutren de contexto semántico instantáneo.',
          'Los índices vectoriales se actualizan automáticamente tras cada interacción.',
        ],
        markdownContent: '## Arquitectura de Integración\nAmbos subsistemas se comunican mediante un broker de eventos asíncronos.',
      },
      model: 'mock-llm',
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/projects/synergies/explore',
      payload: {
        projectAId: projectId,
        projectBId: projB.id,
        saveToVault: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.bridgeTitle).toBe('Puente Conceptual: Agentes y Memoria Vectorial');
    expect(body.sharedProblems.length).toBe(2);
    expect(body.mutualBenefits.length).toBe(2);
    expect(body.writtenToVault).toBe(true);
    expect(body.filePath).toContain('synergy_');

    // Verify bridge file saved in Vault
    const bridgePath = path.join(vaultPath, 'Projects', body.filePath);
    const fileExists = await fs.access(bridgePath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);
    const content = await fs.readFile(bridgePath, 'utf-8');
    expect(content).toContain('type: cross_project_synergy');
    expect(content).toContain('Puente Conceptual: Agentes y Memoria Vectorial');

    evalSpy.mockRestore();
  });

  it('Feature 5: Frontend sirve panel de sinergias y modal de exploración en index.html', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/index.html',
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('id="synergies-section"');
    expect(res.payload).toContain('id="synergies-grid"');
    expect(res.payload).toContain('id="btn-refresh-synergies"');
    expect(res.payload).toContain('id="synergy-bridge-modal"');
    expect(res.payload).toContain('id="synergy-modal-title"');
  });
});


