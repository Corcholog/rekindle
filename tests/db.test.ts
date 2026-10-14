import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';

describe('Database Integration Tests', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    // Usamos la imagen de pgvector
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('loomdb_test')
      .withUsername('tester')
      .withPassword('testpass')
      .start();

    pool = new Pool({
      connectionString: container.getConnectionUri(),
    });
    
    // Habilitar extensión pgvector
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');

    db = drizzle(pool, { schema });
    
    // Correr migraciones sobre la db temporal
    await migrate(db, { migrationsFolder: './drizzle' });
  }, 300000); // 300s timeout to download the image

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('debería insertar un proyecto y lanzar error si se duplica (constraint UNIQUE)', async () => {
    await db.insert(schema.projects).values({
      folderPath: 'Projects/Test1',
      title: 'Test 1',
    });

    const project = await db.select().from(schema.projects).where(eq(schema.projects.folderPath, 'Projects/Test1'));
    expect(project).toHaveLength(1);

    // Intentar duplicar lanza un error por UNIQUE folder_path
    await expect(db.insert(schema.projects).values({
      folderPath: 'Projects/Test1',
      title: 'Duplicado',
    })).rejects.toThrow();
  });

  it('debería insertar contenidos y buscar el vector más cercano (KNN)', async () => {
    // Vector 1: [1, 0, 0, ...]
    const v1 = new Array(1024).fill(0);
    v1[0] = 1;
    v1[1] = 0;
    
    // Vector 2: con distinto ángulo para que cosine distance no sea 0
    const v2 = new Array(1024).fill(0);
    v2[0] = 0.9;
    v2[1] = 0.1;
    
    // Vector 3 (muy distinto): [0, 1, 0, ...]
    const v3 = new Array(1024).fill(0);
    v3[0] = 0;
    v3[1] = 1;

    await db.insert(schema.contents).values([
      { uri: 'http://test.com/1', title: 'Doc 1', embedding: v1 },
      { uri: 'http://test.com/2', title: 'Doc 2', embedding: v2 },
      { uri: 'http://test.com/3', title: 'Doc 3', embedding: v3 },
    ]);

    // Búsqueda KNN del vecino más cercano a v1
    // Nota: usamos <-> (distancia L2) para evitar empates por ángulo con vectores no unitarios
    const targetVector = `[${v1.join(',')}]`;
    const results = await db.execute(sql`
      SELECT uri 
      FROM ${schema.contents} 
      ORDER BY embedding <=> ${targetVector}::vector 
      LIMIT 2
    `);

    // Doc 1 debe ser el más cercano a sí mismo, y Doc 2 el segundo
    expect(results.rows[0].uri).toBe('http://test.com/1');
    expect(results.rows[1].uri).toBe('http://test.com/2');
  });

  it('debería usar el índice HNSW en un EXPLAIN con ~10k filas sintéticas', async () => {
    // Insert 10k rows in batches
    console.log('Inserting 10k synthetic rows for EXPLAIN test...');
    const batchSize = 1000;
    
    for (let i = 0; i < 10; i++) {
      const batch = Array.from({ length: batchSize }).map((_, j) => {
        const id = i * batchSize + j;
        const v = new Array(1024).fill(0).map(() => Math.random());
        return {
          uri: `http://synth.com/${id}`,
          title: `Synth ${id}`,
          embedding: v,
        };
      });
      await db.insert(schema.contents).values(batch);
    }

    const testVector = `[${new Array(1024).fill(0).map(() => Math.random()).join(',')}]`;
    const result = await db.execute(sql`
      EXPLAIN SELECT id FROM ${schema.contents}
      ORDER BY embedding <=> ${testVector}::vector
      LIMIT 5
    `);

    const explainText = result.rows.map(r => r['QUERY PLAN']).join('\n');
    console.log('EXPLAIN PLAN:', explainText);
    
    // Debería mencionar un Index Scan usando hnsw
    expect(explainText.toLowerCase()).toContain('index scan');
    expect(explainText.toLowerCase()).toContain('contents_embedding_idx');
  }, 120000); // Allow more time for this test
});
