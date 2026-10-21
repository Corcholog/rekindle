import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'crypto';
import { installFakeAi, FakeAi } from './helpers/fakeAi';

describe('Evaluation Pipeline Integration', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schemas: any;
  let fake: FakeAi;
  
  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('rekindledb_test_eval')
      .withUsername('tester')
      .withPassword('testpass')
      .start();

    // Stub the environment variable BEFORE any imports occur
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    const { pool, db: drizzleDb } = await import('../src/db/index');
    db = drizzleDb;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });

    schemas = await import('../src/db/schema');
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    fake = installFakeAi(sharedAiProvider);
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    if (container) await container.stop();
    vi.restoreAllMocks();
  });

  it('debería evaluar un contenido nuevo contra los proyectos y crear action suggestions en español', async () => {
    // 1. Mock a project and snapshot
    const projectId = randomUUID();
    await db.insert(schemas.projects).values({
      id: projectId,
      folderPath: 'Projects/TestProject',
      title: 'Test Project',
      currentHash: 'hash123'
    });

    const snapshotId = randomUUID();
    // Simulate a project about AI Agents
    const thesisText = "Estoy construyendo un sistema de agentes autónomos que se comunican usando un sistema de bus de eventos (pub/sub). El objetivo es que puedan colaborar para resolver tareas complejas sin intervención humana.";
    
    // Generar un embedding "falso" de 1024D rellenado con 0s y unos (solo para que no de error)
    // Pero espera, vamos a generar un embedding real o falso? 
    // Ollama intentará buscar, así que un embedding falso de 1024 dimension array of 0.1 works.
    const projectEmbedding = new Array(1024).fill(0.1);
    
    await db.insert(schemas.projectSnapshots).values({
      id: snapshotId,
      projectId: projectId,
      treeHash: 'hash123',
      thesisText,
      embedding: projectEmbedding,
      embeddingModel: 'bge-m3',
    });

    // 2. Mock a Content
    const contentId = randomUUID();
    const contentSummary = "Este artículo discute cómo el patrón Pub/Sub puede escalar drásticamente los sistemas multi-agente al permitir que los componentes se desacoplen completamente, reduciendo cuellos de botella.";
    const contentEmbedding = new Array(1024).fill(0.11); // Very close mathematically
    
    await db.insert(schemas.contents).values({
      id: contentId,
      uri: 'https://example.com/pub-sub-agents',
      title: 'Pub Sub Agents',
      summary: contentSummary,
      embedding: contentEmbedding,
      embeddingModel: 'bge-m3',
      ingestStatus: 'ready'
    });

    // 3. Run Evaluation manually, with a scripted model answer
    fake.answerNext({
      verdict: 'actionable',
      confidenceScore: 0.85,
      triageReasoning: 'El artículo aporta evidencia sobre el desacople con pub/sub en sistemas multi-agente.',
      action: {
        actionType: 'evidence_citation',
        observation: 'Muestra cómo pub/sub elimina cuellos de botella entre agentes.',
        suggestedAction: 'Citar el artículo al justificar el bus de eventos.',
        targetFile: null,
      },
    });
    const { evaluateContentMatch } = await import('../src/evaluator');
    await evaluateContentMatch(contentId);

    // The triage prompt carried the article summary and the project thesis
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].kind).toBe('triage');
    expect(fake.calls[0].user).toContain(contentSummary);
    expect(fake.calls[0].user).toContain(thesisText);

    // 4. Assert Results
    const evaluations = await db.select().from(schemas.evaluations).where(eq(schemas.evaluations.contentId, contentId));
    expect(evaluations.length).toBeGreaterThan(0);
    expect(evaluations[0].verdict).toBe('actionable');

    const actions = await db.select().from(schemas.actionSuggestions).where(eq(schemas.actionSuggestions.evaluationId, evaluations[0].id));
    expect(actions.length).toBe(1);
    expect(actions[0].actionType).toBeDefined();
    
    expect(actions[0].actionType).toBe('evidence_citation');
    expect(actions[0].observation).toBe('Muestra cómo pub/sub elimina cuellos de botella entre agentes.');
    expect(actions[0].suggestedAction).toBe('Citar el artículo al justificar el bus de eventos.');
  }, 60000);

  it('guarda como irrelevante una respuesta "actionable" cuya acción es descartar el artículo', async () => {
    const projectId = randomUUID();
    await db.insert(schemas.projects).values({ id: projectId, folderPath: 'Projects/Descarte', title: 'Descarte' });
    const vector = new Array(1024).fill(0).map((_, i) => (i % 7 === 0 ? 1 : 0));
    const [snapshot] = await db.insert(schemas.projectSnapshots).values({
      projectId, treeHash: 'h-descarte', thesisText: 'Tesis', embedding: vector, embeddingModel: 'bge-m3',
    }).returning();
    const [content] = await db.insert(schemas.contents).values({
      uri: 'https://example.com/descarte', summary: 'Resumen', embedding: vector, embeddingModel: 'bge-m3', ingestStatus: 'ready',
    }).returning();

    fake.answerNext({
      verdict: 'actionable', confidenceScore: 0.8, triageReasoning: 'Parece relacionado.',
      action: { actionType: 'other', observation: 'No aporta nada nuevo.', suggestedAction: 'Descartar el artículo.', targetFile: null },
    });
    const { evaluateContentMatch } = await import('../src/evaluator');
    const stats = await evaluateContentMatch(content.id, projectId);

    expect(stats).toMatchObject({ evaluated: 1, suggestions: 0 });
    const [evaluation] = await db.select().from(schemas.evaluations).where(eq(schemas.evaluations.projectSnapshotId, snapshot.id));
    expect(evaluation.verdict).toBe('irrelevant');
    expect(evaluation.triageReasoning).toBe('Parece relacionado.\n\n[Motivo de descarte]: No aporta nada nuevo.');
    expect(await db.select().from(schemas.actionSuggestions).where(eq(schemas.actionSuggestions.evaluationId, evaluation.id))).toHaveLength(0);
  });
  it('with English output, asks for English and catches an English discard', async () => {
    vi.stubEnv('OUTPUT_LANGUAGE', 'en');
    const projectId = randomUUID();
    await db.insert(schemas.projects).values({ id: projectId, folderPath: 'Projects/Discard', title: 'Discard' });
    const vector = new Array(1024).fill(0).map((_, i) => (i % 5 === 0 ? 1 : 0));
    const [snapshot] = await db.insert(schemas.projectSnapshots).values({
      projectId, treeHash: 'h-discard-en', thesisText: 'Thesis', embedding: vector, embeddingModel: 'bge-m3',
    }).returning();
    const [content] = await db.insert(schemas.contents).values({
      uri: 'https://example.com/discard-en', summary: 'Summary', embedding: vector, embeddingModel: 'bge-m3', ingestStatus: 'ready',
    }).returning();

    fake.calls.length = 0;
    fake.answerNext({
      verdict: 'actionable', confidenceScore: 0.8, triageReasoning: 'Looks related.',
      action: { actionType: 'other', observation: 'It adds nothing new.', suggestedAction: 'Discard the article.', targetFile: null },
    });
    const { evaluateContentMatch } = await import('../src/evaluator');
    await evaluateContentMatch(content.id, projectId);
    vi.stubEnv('OUTPUT_LANGUAGE', ''); // back to the default (Spanish)

    expect(fake.calls[0].system).toContain('Debes responder SIEMPRE en INGLÉS.');
    const [evaluation] = await db.select().from(schemas.evaluations).where(eq(schemas.evaluations.projectSnapshotId, snapshot.id));
    expect(evaluation.verdict).toBe('irrelevant');
    expect(evaluation.triageReasoning).toBe('Looks related.\n\n[Reason for discarding]: It adds nothing new.');
  });
});
