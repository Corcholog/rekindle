import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

describe('Ingestion Pipeline Integration', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let db: any;
  let boss: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('loomdb_test')
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

    const { boss: pgBoss, startQueue } = await import('../src/queue/index');
    boss = pgBoss;
    await startQueue();

    const { setupIngestionWorker } = await import('../src/workers/ingestionWorker');
    await setupIngestionWorker();

    const ingestRoute = (await import('../src/api/routes/ingest')).default;
    
    server = Fastify().withTypeProvider<ZodTypeProvider>();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.register(ingestRoute);
    await server.ready();

    // Mock fetch to simulate downloading an article
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `<html><head><title>Test Article</title></head><body><p>Este es un articulo de prueba sobre inteligencia artificial. Habla sobre redes neuronales y machine learning.</p></body></html>`
    } as any);
  }, 300000);

  afterAll(async () => {
    if (boss) await boss.stop();
    const { pool } = await import('../src/db/index');
    await pool.end();
    if (container) await container.stop();
    vi.restoreAllMocks();
  });

  it('debería procesar la ingesta de URL de principio a fin (Scraping -> Summary -> Embedding)', async () => {
    // 1. Post to ingest
    console.log('Sending POST to /api/ingest...');
    const response = await server.inject({
      method: 'POST',
      url: '/api/ingest',
      payload: { url: 'https://test.com/ai-article' }
    });

    console.log('Response status:', response.statusCode);
    const body = response.json();
    console.log('Response body:', body);
    expect(body.contentId).toBeDefined();
    expect(body.message).toBe('URL accepted for processing');

    const contentId = body.contentId;
    const { contents } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');

    // 2. Poll DB for completion
    let status = 'pending';
    let record: any;
    // Wait up to 180 seconds since Ollama might take a bit for summarization/embedding (cold start)
    for (let i = 0; i < 180; i++) { 
      await new Promise(r => setTimeout(r, 1000));
      const res = await db.select().from(contents).where(eq(contents.id, contentId));
      if (res.length > 0) {
        record = res[0];
        status = record.ingestStatus;
        if (status === 'ready' || status === 'failed') break;
      }
      
      if (i % 5 === 0) {
        const { sql } = await import('drizzle-orm');
        const jobs = await db.execute(sql`SELECT state, data, name, output FROM pgboss.job`);
        console.log(`Polling... Status: ${status}, Jobs in queue:`, jobs.rows);
      }
    }

    expect(status).toBe('ready');
    expect(record.rawText).toContain('Este es un articulo de prueba sobre inteligencia artificial');
    expect(record.title).toBe('Test Article');
    expect(record.summary).toBeDefined();
    
    // Check vector properties
    expect(Array.isArray(record.embedding)).toBe(true);
    expect(record.embedding.length).toBe(1024);
    expect(record.embeddingModel).toBe('bge-m3');
  }, 240000); // Give the test plenty of time
});
