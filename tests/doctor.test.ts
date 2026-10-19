import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runChecks, renderChecks, hasFailures, activeProviders, Probes } from '../src/doctor/checks';
import { probeDatabase, probeOllamaModels, probeVaultProjects, expectedMigrations } from '../src/doctor/probes';

const healthy = (overrides: Partial<Probes> = {}): Probes => ({
  nodeVersion: 'v22.4.0',
  env: {},
  envFileExists: true,
  expectedMigrations: 7,
  database: async () => ({ reachable: true, hasVector: true, appliedMigrations: 7 }),
  ollamaModels: async () => ['bge-m3:latest', 'qwen2.5:7b-instruct'],
  vaultProjects: async () => ['Faro', 'Ensayo'],
  demoVaultPath: '/repo/demo_vault',
  webBuilt: true,
  ...overrides,
});
const statusOf = async (probes: Probes) => Object.fromEntries((await runChecks(probes)).map(r => [r.id, r.status]));

describe('doctor checks', () => {
  it('passes on a healthy local setup and says nothing leaves the machine', async () => {
    const results = await runChecks(healthy());
    expect(hasFailures(results)).toBe(false);
    expect(results.find(r => r.id === 'providers')!.detail).toMatch(/nothing leaves this machine/);
    expect(renderChecks(results)).toContain('Ready: all required checks passed.');
  });

  it('flags an old Node, with the fix', async () => {
    const results = await runChecks(healthy({ nodeVersion: 'v20.11.0' }));
    expect(results.find(r => r.id === 'node')).toMatchObject({ status: 'fail', fix: expect.stringContaining('Node.js 22') });
  });

  it('asks to start Postgres when it is down, and to migrate when the schema is behind', async () => {
    const down = await runChecks(healthy({ database: async () => ({ reachable: false, error: 'ECONNREFUSED' }) }));
    expect(down.find(r => r.id === 'database')).toMatchObject({ status: 'fail', fix: 'docker compose up -d postgres' });
    expect(down.find(r => r.id === 'migrations')).toBeUndefined();

    const behind = await runChecks(healthy({ database: async () => ({ reachable: true, hasVector: true, appliedMigrations: 3 }) }));
    expect(behind.find(r => r.id === 'migrations')).toMatchObject({ status: 'fail', detail: '3 of 7 migrations applied', fix: 'pnpm db:migrate' });
    const noVector = await runChecks(healthy({ database: async () => ({ reachable: true, hasVector: false, appliedMigrations: 0 }) }));
    expect(noVector.find(r => r.id === 'migrations')!.detail).toContain('pgvector missing');
  });

  it('reports Ollama down, and a missing embedding model, as failures', async () => {
    expect((await statusOf(healthy({ ollamaModels: async () => null }))).ollama).toBe('fail');
    const results = await runChecks(healthy({ ollamaModels: async () => ['qwen2.5:7b-instruct'] }));
    expect(results.find(r => r.id === 'embed-model')).toMatchObject({ status: 'fail', fix: 'ollama pull bge-m3' });
  });

  it('needs the local chat model only when no cloud key is set', async () => {
    const onlyEmbed = async () => ['bge-m3:latest'];
    expect((await statusOf(healthy({ ollamaModels: onlyEmbed })))['chat-model']).toBe('fail');
    expect((await statusOf(healthy({ ollamaModels: onlyEmbed, env: { DEEPSEEK_API_KEY: 'x' } })))['chat-model']).toBe('warn');
  });

  it('checks the demo vault by default and a configured vault otherwise', async () => {
    let asked = '';
    const probes = healthy({ vaultProjects: async p => { asked = p; return null; } });
    expect((await runChecks(probes)).find(r => r.id === 'vault')).toMatchObject({ status: 'fail' });
    expect(asked).toBe('/repo/demo_vault');
    await runChecks({ ...probes, env: { VAULT_PATH: '/mi/vault' } });
    expect(asked).toBe('/mi/vault');
    expect((await statusOf(healthy({ vaultProjects: async () => [] }))).vault).toBe('warn');
  });

  it('lists the active cloud providers without ever including key values', async () => {
    const env = { DEEPSEEK_API_KEY: 'sk-SECRET-VALUE', GEMINI_API_KEY: '', LLM_PROVIDERS: 'deepseek,gemini,ollama' };
    expect(activeProviders(env)).toEqual(['deepseek', 'ollama']);
    const output = renderChecks(await runChecks(healthy({ env })));
    expect(output).toContain('deepseek > ollama');
    expect(output).not.toContain('SECRET');
  });

  it('asks to build the web UI when web/dist is missing', async () => {
    const results = await runChecks(healthy({ webBuilt: false }));
    expect(results.find(r => r.id === 'web')).toMatchObject({ status: 'fail', fix: 'pnpm build:web' });
  });

  it('warns, without failing, when .env is missing', async () => {
    const results = await runChecks(healthy({ envFileExists: false }));
    expect(results.find(r => r.id === 'env')).toMatchObject({ status: 'warn', fix: 'cp .env.example .env' });
    expect(hasFailures(results)).toBe(false);
  });
});

describe('doctor probes', () => {
  let container: StartedPostgreSqlContainer;
  let ollama: http.Server;
  let ollamaUrl: string;
  let tmp: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    ollama = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'bge-m3:latest' }] }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve));
    ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-doctor-'));
  }, 120000);

  afterAll(async () => {
    ollama?.close();
    await container?.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('sees an empty database, then a migrated one', async () => {
    const url = container.getConnectionUri();
    expect(await probeDatabase(url)).toMatchObject({ reachable: true, hasVector: false, appliedMigrations: 0 });

    const pool = new Pool({ connectionString: url });
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    await pool.end();

    const state = await probeDatabase(url);
    expect(state).toMatchObject({ reachable: true, hasVector: true });
    expect(state.appliedMigrations).toBe(await expectedMigrations());
  });

  it('reports an unreachable database by error code only', async () => {
    const state = await probeDatabase('postgres://u:secretpass@127.0.0.1:1/db');
    expect(state.reachable).toBe(false);
    expect(JSON.stringify(state)).not.toContain('secretpass');
  });

  it('lists Ollama models, and null when it is down', async () => {
    expect(await probeOllamaModels(ollamaUrl)).toEqual(['bge-m3:latest']);
    expect(await probeOllamaModels('http://127.0.0.1:1')).toBeNull();
  });

  it('finds project folders in Projects/ or Proyectos/ and ignores hidden ones', async () => {
    await fs.mkdir(path.join(tmp, 'Proyectos', 'Novela'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'Proyectos', '.trash'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'Proyectos', 'suelto.md'), '# x');
    expect(await probeVaultProjects(tmp)).toEqual(['Novela']);
    expect(await probeVaultProjects(path.join(tmp, 'nope'))).toBeNull();
    expect(await probeVaultProjects(path.resolve('demo_vault'))).toHaveLength(4);
  });
});
