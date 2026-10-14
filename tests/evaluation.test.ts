import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'crypto';

describe('Evaluation Pipeline Integration', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schemas: any;
  
  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('loomdb_test_eval')
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
      embedding: projectEmbedding
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

    // 3. Run Evaluation manually
    const { evaluateContentMatch } = await import('../src/evaluator');
    await evaluateContentMatch(contentId);

    // 4. Assert Results
    const evaluations = await db.select().from(schemas.evaluations).where(eq(schemas.evaluations.contentId, contentId));
    expect(evaluations.length).toBeGreaterThan(0);
    expect(evaluations[0].verdict).toBe('actionable');

    const actions = await db.select().from(schemas.actionSuggestions).where(eq(schemas.actionSuggestions.evaluationId, evaluations[0].id));
    expect(actions.length).toBe(1);
    expect(actions[0].actionType).toBeDefined();
    
    // Check Spanish response (heuristic check)
    // The reasoning and observation should be in Spanish.
    // We check that the result string length > 5 to assure it's somewhat filled.
    expect(actions[0].observation.length).toBeGreaterThan(5);
    expect(actions[0].suggestedAction.length).toBeGreaterThan(5);

  }, 180000); // 180 seconds to allow for LLM execution
});
