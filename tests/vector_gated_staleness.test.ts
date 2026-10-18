import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Option C: Vector-Gated Staleness & Context-Aware Re-evaluation Tests', () => {
  let container: any;
  let vaultPath: string;
  let server: any;
  let projectId: string;
  let contentId: string;
  let snap1Id: string;
  let snap2Id: string;
  let sugId: string;

  // Helper to create 1024-dim normalized embedding vectors
  function createUnitVector(primaryIndex = 0, delta = 0): number[] {
    const vec = new Array(1024).fill(0);
    vec[primaryIndex] = 1 - delta;
    vec[(primaryIndex + 1) % 1024] = delta;
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return vec.map(v => v / norm);
  }

  beforeAll(async () => {
    // 1. Setup Test DB
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('loomdb_staleness_test')
      .withUsername('tester')
      .withPassword('testpass')
      .start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    // 2. Dummy Vault
    vaultPath = path.join(__dirname, 'DummyVault_Staleness');
    await fs.mkdir(path.join(vaultPath, 'Projects', 'Autonomous_Agents'), { recursive: true });
    vi.stubEnv('VAULT_PATH', vaultPath);

    // 3. Init DB schema
    const { pool, db: drizzleDb } = await import('../src/db/index');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(drizzleDb, { migrationsFolder: './drizzle' });

    // 4. Seed Data
    const { projects, projectSnapshots, projectNoteSnapshots, contents, evaluations, actionSuggestions } = await import('../src/db/schema');

    const [proj] = await drizzleDb.insert(projects).values({
      folderPath: 'Projects/Autonomous_Agents',
      title: 'Autonomous Agents',
    }).returning({ id: projects.id });
    projectId = proj.id;

    const baseEmbedding = createUnitVector(0, 0); // e0 = 1.0

    // Seed Initial Snapshot (Snap 1)
    const [snap1] = await drizzleDb.insert(projectSnapshots).values({
      projectId,
      treeHash: 'tree-snap-1',
      thesisText: 'Tesis inicial sobre agentes reactivos.',
      embedding: baseEmbedding,
      embeddingModel: 'bge-m3',
      capturedAt: new Date(Date.now() - 60000),
    }).returning({ id: projectSnapshots.id });
    snap1Id = snap1.id;

    // Seed Note in Snap 1
    await drizzleDb.insert(projectNoteSnapshots).values({
      projectSnapshotId: snap1Id,
      projectId,
      notePath: 'chapter1/architecture.md',
      noteTitle: 'Architecture Overview',
      contentSnippet: 'Event driven architecture.',
      embedding: baseEmbedding,
      embeddingModel: 'bge-m3',
    });

    // Seed Content
    const [c] = await drizzleDb.insert(contents).values({
      uri: 'https://research.org/distributed-agents',
      title: 'Distributed Agents Paper',
      summary: 'State of the art in distributed consensus and agent coordination.',
      ingestStatus: 'ready',
      embedding: baseEmbedding,
      embeddingModel: 'bge-m3',
    }).returning({ id: contents.id });
    contentId = c.id;

    // Seed Initial Evaluation on Snap 1
    const [ev] = await drizzleDb.insert(evaluations).values({
      contentId,
      projectSnapshotId: snap1Id,
      verdict: 'actionable',
      confidenceScore: 0.90,
      triageReasoning: 'Alta relevancia con la arquitectura de eventos.',
      consumptionSeq: 1,
      evaluatedAt: new Date(Date.now() - 50000),
    }).returning({ id: evaluations.id });

    // Seed Action Suggestion referencing Snap 1
    const [sug] = await drizzleDb.insert(actionSuggestions).values({
      evaluationId: ev.id,
      projectId,
      contentId,
      actionType: 'evidence_citation',
      observation: 'Citar en el capítulo 1 sobre eventos distribuidos.',
      suggestedAction: 'Añadir cita en architecture.md',
      targetFile: 'architecture.md',
      status: 'pending',
      writtenToVault: false,
      createdAt: new Date(Date.now() - 50000),
    }).returning({ id: actionSuggestions.id });
    sugId = sug.id;

    // 5. Load Server
    const serverModule = await import('../src/api/server');
    server = serverModule.server;
    await server.ready();
  }, 120000);

  afterAll(async () => {
    if (server) await server.close();
    if (container) await container.stop();
    await fs.rm(vaultPath, { recursive: true, force: true }).catch(() => {});
  });

  it('Fix 3: Devuelve isStale = false cuando el proyecto no ha sufrido deriva semántica', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/suggestions?projectId=${projectId}&status=pending`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.items.length).toBe(1);
    const item = body.items[0];
    expect(item.id).toBe(sugId);
    expect(item.isStale).toBe(false);
    expect(item.driftScore).toBe(0);
  });

  it('Fix 3: Detecta isStale = true y deriva semántica cuando se añade un nuevo snapshot con drift >= 0.04', async () => {
    const { db: drizzleDb } = await import('../src/db/index');
    const { projectSnapshots, projectNoteSnapshots } = await import('../src/db/schema');

    // Create a drifted vector with cosine distance ~0.08
    const driftedVector = createUnitVector(0, 0.3);

    const [snap2] = await drizzleDb.insert(projectSnapshots).values({
      projectId,
      treeHash: 'tree-snap-2',
      thesisText: 'Tesis evolucionada hacia agentes deliberativos y grafos de conocimiento.',
      embedding: driftedVector,
      embeddingModel: 'bge-m3',
      capturedAt: new Date(),
    }).returning({ id: projectSnapshots.id });
    snap2Id = snap2.id;

    // Note also drifted or changed in new snapshot
    await drizzleDb.insert(projectNoteSnapshots).values({
      projectSnapshotId: snap2Id,
      projectId,
      notePath: 'chapter1/architecture.md',
      noteTitle: 'Architecture Overview Updated',
      contentSnippet: 'Shifted from broker to decentralized mesh.',
      embedding: driftedVector,
      embeddingModel: 'bge-m3',
    });

    const res = await server.inject({
      method: 'GET',
      url: `/api/suggestions?projectId=${projectId}&status=pending`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.items.length).toBe(1);
    const item = body.items[0];
    expect(item.id).toBe(sugId);
    expect(item.isStale).toBe(true);
    expect(item.driftScore).toBeGreaterThanOrEqual(0.04);
  });

  it('Fix 2: POST /api/suggestions/:id/reevaluate con keep_or_refine inserta nueva evaluación para latestSnapshot y limpia isStale', async () => {
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    const { db: drizzleDb } = await import('../src/db/index');
    const { evaluations, actionSuggestions } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');

    const evalSpy = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValueOnce({
      data: {
        resolution: 'keep_or_refine',
        reasoning: 'El artículo sigue aportando evidencia clave a pesar de la transición a arquitectura mesh.',
        refinedAction: {
          actionType: 'counter_argument',
          observation: 'Contrastar la latencia de brokers centralizados frente a mesh descentralizado.',
          suggestedAction: 'Discutir compensaciones de latencia en architecture.md',
          targetFile: 'architecture.md',
        },
      },
      model: 'mock-llm',
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/suggestions/${sugId}/reevaluate`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.resolution).toBe('keep_or_refine');
    expect(body.suggestion.actionType).toBe('counter_argument');
    expect(body.suggestion.isStale).toBe(false);

    // Verify action_suggestions in DB points to a new evaluation linked to snap2
    const [sugDb] = await drizzleDb.select().from(actionSuggestions).where(eq(actionSuggestions.id, sugId));
    expect(sugDb.actionType).toBe('counter_argument');

    const [evalDb] = await drizzleDb.select().from(evaluations).where(eq(evaluations.id, sugDb.evaluationId));
    expect(evalDb.projectSnapshotId).toBe(snap2Id);
    expect(evalDb.verdict).toBe('actionable');

    // Subsequent GET query returns isStale = false
    const getRes = await server.inject({
      method: 'GET',
      url: `/api/suggestions?projectId=${projectId}&status=pending`,
    });
    const getBody = JSON.parse(getRes.payload);
    const updatedItem = getBody.items.find((i: any) => i.id === sugId);
    expect(updatedItem.isStale).toBe(false);

    evalSpy.mockRestore();
  });

  it('Fix 2: POST /api/suggestions/:id/reevaluate con already_addressed descarta la sugerencia con prefijo explicativo', async () => {
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    const { db: drizzleDb } = await import('../src/db/index');
    const { actionSuggestions } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');

    // Reset suggestion to pending to test re-evaluation transition to discarded
    await drizzleDb.update(actionSuggestions).set({
      status: 'pending',
    }).where(eq(actionSuggestions.id, sugId));

    const evalSpy = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValueOnce({
      data: {
        resolution: 'already_addressed',
        reasoning: 'El autor ya citó e incorporó el estudio en el borrador de architecture.md.',
        refinedAction: null,
      },
      model: 'mock-llm',
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/suggestions/${sugId}/reevaluate`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.resolution).toBe('already_addressed');
    expect(body.suggestion.status).toBe('discarded');
    expect(body.suggestion.observation).toContain('[Ya abordado en el borrador actual]');

    evalSpy.mockRestore();
  });

  it('Fix 5: POST /api/projects/:id/reevaluate-stale procesa en lote sugerencias pendientes desactualizadas', async () => {
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    const { db: drizzleDb } = await import('../src/db/index');
    const { actionSuggestions, projectSnapshots } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');

    // Create a third snapshot with further drift
    const farVector = createUnitVector(1, 0.4);
    await drizzleDb.insert(projectSnapshots).values({
      projectId,
      treeHash: 'tree-snap-3',
      thesisText: 'Cambio radical hacia sistemas neuro-simbólicos.',
      embedding: farVector,
      embeddingModel: 'bge-m3',
      capturedAt: new Date(),
    });

    // Set suggestion back to pending (so it evaluates against snap3 as stale)
    await drizzleDb.update(actionSuggestions).set({
      status: 'pending',
      observation: 'Cita preliminar sobre sistemas distribuidos.',
    }).where(eq(actionSuggestions.id, sugId));

    const evalSpy = vi.spyOn(sharedAiProvider, 'evaluateContent').mockResolvedValueOnce({
      data: {
        resolution: 'obsolete',
        reasoning: 'El proyecto ahora se enfoca en neuro-simbólico; los brokers distribuidos ya no aplican.',
        refinedAction: null,
      },
      model: 'mock-llm',
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/reevaluate-stale`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.reevaluatedCount).toBe(1);
    expect(body.results[0].resolution).toBe('obsolete');

    evalSpy.mockRestore();
  });

  it('Fix 1: findBacklogUnevaluatedContents solo auto-promueve tentativos con delta significativo y evita loops infinitos', async () => {
    const { db: drizzleDb } = await import('../src/db/index');
    const { contents, evaluations, projectSnapshots } = await import('../src/db/schema');
    const { findBacklogUnevaluatedContents } = await import('../src/evaluator/index');

    // Create content with embedding
    const contentEmbedding = createUnitVector(2, 0);
    const [cTentative] = await drizzleDb.insert(contents).values({
      uri: 'https://arxiv.org/abs/tentative-test',
      title: 'Tentative Paper',
      summary: 'Potential connection to agent architecture.',
      ingestStatus: 'ready',
      embedding: contentEmbedding,
      embeddingModel: 'bge-m3',
    }).returning({ id: contents.id });

    // Snapshot A: distant project vector
    const distantVector = createUnitVector(3, 0);
    const [snapA] = await drizzleDb.insert(projectSnapshots).values({
      projectId,
      treeHash: 'tree-snap-A',
      embedding: distantVector,
      embeddingModel: 'bge-m3',
      capturedAt: new Date(Date.now() - 40000),
    }).returning({ id: projectSnapshots.id });

    // Historical Evaluation on Snap A: tentative
    await drizzleDb.insert(evaluations).values({
      contentId: cTentative.id,
      projectSnapshotId: snapA.id,
      verdict: 'tentative',
      consumptionSeq: 10,
      evaluatedAt: new Date(Date.now() - 30000),
    });

    // Case 1: Snapshot B moves CLOSER to content by >= 0.08
    // content is at createUnitVector(2, 0).
    // Let's create snapB vector closer to vector 2 (delta >= 0.08)
    const closerVector = createUnitVector(2, 0.1);
    const [snapB] = await drizzleDb.insert(projectSnapshots).values({
      projectId,
      treeHash: 'tree-snap-B',
      embedding: closerVector,
      embeddingModel: 'bge-m3',
      capturedAt: new Date(),
    }).returning({ id: projectSnapshots.id });

    const candidates = await findBacklogUnevaluatedContents(projectId, 10);
    expect(candidates).toContain(cTentative.id);

    // Case 2: Prevention of Infinite Loop
    // Now Snapshot B evaluates it as 'irrelevant' (or user discards it)
    await drizzleDb.insert(evaluations).values({
      contentId: cTentative.id,
      projectSnapshotId: snapB.id,
      verdict: 'irrelevant',
      consumptionSeq: 11,
      evaluatedAt: new Date(),
    });

    // Snapshot C is created later
    await drizzleDb.insert(projectSnapshots).values({
      projectId,
      treeHash: 'tree-snap-C',
      embedding: closerVector,
      embeddingModel: 'bge-m3',
      capturedAt: new Date(),
    });

    // Because Snapshot B's latest evaluation is 'irrelevant', Snapshot A's old 'tentative' row MUST NOT re-trigger
    const candidatesAfterIrrelevant = await findBacklogUnevaluatedContents(projectId, 10);
    expect(candidatesAfterIrrelevant).not.toContain(cTentative.id);
  });

  it('Fix 4: Los conteos de badges en GET /api/projects y GET /api/suggestions coinciden exactamente', async () => {
    const projRes = await server.inject({
      method: 'GET',
      url: '/api/projects',
    });
    expect(projRes.statusCode).toBe(200);
    const body = JSON.parse(projRes.payload);
    const projectsList = body.projects || body;
    const targetProj = projectsList.find((p: any) => p.id === projectId);
    expect(targetProj).toBeDefined();

    const sugRes = await server.inject({
      method: 'GET',
      url: `/api/suggestions?projectId=${projectId}&status=active`,
    });
    expect(sugRes.statusCode).toBe(200);
    const sugBody = JSON.parse(sugRes.payload);

    // Badge count in projects matches suggestions total
    expect(targetProj.counts.active).toBe(sugBody.total);
  });
});
