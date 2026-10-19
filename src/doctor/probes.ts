import * as fs from 'fs/promises';
import * as path from 'path';
import { Pool } from 'pg';
import { PROJECT_DIR_NAMES } from '../config';
import type { DbState, Probes } from './checks';

const PROBE_TIMEOUT_MS = 3000;

export async function probeDatabase(databaseUrl: string): Promise<DbState> {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: PROBE_TIMEOUT_MS });
  pool.on('error', () => {});
  try {
    const vector = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    let applied = 0;
    try {
      applied = Number((await pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n);
    } catch {
      // The migrations table does not exist before the first migration
    }
    return { reachable: true, hasVector: vector.rowCount === 1, appliedMigrations: applied };
  } catch (err) {
    return { reachable: false, error: (err as { code?: string }).code ?? (err as Error).name };
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function probeOllamaModels(ollamaUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(new URL('/api/tags', ollamaUrl), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.json() as { models?: { name: string }[] };
    return (body.models ?? []).map(m => m.name);
  } catch {
    return null;
  }
}

export async function probeVaultProjects(vaultPath: string): Promise<string[] | null> {
  try {
    await fs.access(vaultPath);
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const dirName of PROJECT_DIR_NAMES) {
    try {
      const entries = await fs.readdir(path.join(vaultPath, dirName), { withFileTypes: true });
      found.push(...entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name));
    } catch {
      // This folder name is not used in the vault
    }
  }
  return found;
}

export async function expectedMigrations(root = process.cwd()): Promise<number> {
  const journal = JSON.parse(await fs.readFile(path.join(root, 'drizzle', 'meta', '_journal.json'), 'utf-8'));
  return journal.entries.length;
}

export async function realProbes(env: NodeJS.ProcessEnv, root = process.cwd()): Promise<Probes> {
  return {
    nodeVersion: process.version,
    env,
    envFileExists: await fs.access(path.join(root, '.env')).then(() => true, () => false),
    expectedMigrations: await expectedMigrations(root),
    database: () => probeDatabase(env.DATABASE_URL || 'postgres://loom:loompassword@localhost:5432/loomdb'),
    ollamaModels: () => probeOllamaModels(env.OLLAMA_URL || 'http://127.0.0.1:11434'),
    vaultProjects: probeVaultProjects,
    demoVaultPath: path.join(root, 'demo_vault'),
  };
}
