import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

describe('language settings API', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('LANGUAGE', 'en');
    vi.stubEnv('OUTPUT_LANGUAGE', '');
    vi.stubEnv('NOTES_LANGUAGE', '');
    const { pool, db } = await import('../src/db/index');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    server = (await import('../src/api/server')).server;
    await server.ready();
  }, 120000);

  afterAll(async () => {
    await server?.close();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  const put = (payload: object) => server.inject({ method: 'PUT', url: '/api/settings/language', payload });

  it('reports the preset and the effective languages', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/settings/language' });
    expect(res.json()).toEqual({ preset: 'en', outputLanguage: 'en', notesLanguage: 'en' });
  });

  it('changes each language on its own and applies it at once', async () => {
    expect((await put({ notesLanguage: 'es' })).json()).toEqual({ preset: 'en', outputLanguage: 'en', notesLanguage: 'es' });
    expect(process.env.NOTES_LANGUAGE).toBe('es');
    const { notesLanguage, outputLanguage } = await import('../src/ai/language');
    expect([outputLanguage(), notesLanguage()]).toEqual(['en', 'es']);
    expect((await put({ outputLanguage: 'es' })).json()).toMatchObject({ outputLanguage: 'es' });
  });

  it('rejects unknown languages and empty updates', async () => {
    expect((await put({ outputLanguage: 'fr' })).statusCode).toBe(400);
    expect((await put({ notesLanguage: 'es\nGEMINI_API_KEY=x' })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
  });

  it('validates the language variables at startup, treating empty as unset', async () => {
    // Imported here: src/config binds DATABASE_URL on first import
    const { parseEnv } = await import('../src/config');
    expect(parseEnv({ LANGUAGE: 'en', OUTPUT_LANGUAGE: '' })).toMatchObject({ LANGUAGE: 'en', OUTPUT_LANGUAGE: undefined });
    expect(() => parseEnv({ LANGUAGE: 'fr' })).toThrow();
  });
});
