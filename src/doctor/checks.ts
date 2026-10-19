// Preflight checks for a fresh install. Each check reads the world through `Probes`, so the
// logic is tested without Docker or Ollama. Results say what is wrong and the command that fixes it.
// Secrets are only checked for presence; their values are never read into a result.

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DbState {
  reachable: boolean;
  error?: string;
  hasVector?: boolean;
  appliedMigrations?: number;
}

export interface Probes {
  nodeVersion: string;
  env: Record<string, string | undefined>;
  envFileExists: boolean;
  /** Migration files shipped in the repo (entries in drizzle/meta/_journal.json). */
  expectedMigrations: number;
  database(): Promise<DbState>;
  /** Names of the models pulled in Ollama, or null when Ollama does not answer. */
  ollamaModels(): Promise<string[] | null>;
  /** Names of the project folders found under the vault's Projects/ or Proyectos/. */
  vaultProjects(vaultPath: string): Promise<string[] | null>;
  demoVaultPath: string;
}

export const MIN_NODE_MAJOR = 22;
export const LOCAL_CHAT_MODEL = 'qwen2.5:7b-instruct';

const hasModel = (models: string[], wanted: string) =>
  models.some(m => m === wanted || m === `${wanted}:latest` || m.split(':')[0] === wanted);

export function activeProviders(env: Record<string, string | undefined>): string[] {
  const order = (env.LLM_PROVIDERS || 'deepseek,gemini,ollama').split(',').map(p => p.trim()).filter(Boolean);
  return order.filter(p => p === 'ollama' || (p === 'deepseek' && env.DEEPSEEK_API_KEY) || (p === 'gemini' && env.GEMINI_API_KEY));
}

export async function runChecks(probes: Probes): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => results.push(r);

  const major = Number(probes.nodeVersion.replace(/^v/, '').split('.')[0]);
  add(major >= MIN_NODE_MAJOR
    ? { id: 'node', label: 'Node.js', status: 'ok', detail: probes.nodeVersion }
    : { id: 'node', label: 'Node.js', status: 'fail', detail: `${probes.nodeVersion} is too old; Loom needs ${MIN_NODE_MAJOR} or newer`, fix: 'Install Node.js 22 or newer (https://nodejs.org)' });

  add(probes.envFileExists
    ? { id: 'env', label: '.env file', status: 'ok', detail: 'found' }
    : { id: 'env', label: '.env file', status: 'warn', detail: 'not found, defaults are used', fix: 'cp .env.example .env' });

  const db = await probes.database();
  if (!db.reachable) {
    add({ id: 'database', label: 'PostgreSQL', status: 'fail', detail: `not reachable (${db.error ?? 'unknown error'})`, fix: 'docker compose up -d postgres' });
  } else {
    add({ id: 'database', label: 'PostgreSQL', status: 'ok', detail: 'reachable' });
    const applied = db.appliedMigrations ?? 0;
    add(!db.hasVector || applied < probes.expectedMigrations
      ? {
        id: 'migrations', label: 'Database schema', status: 'fail',
        detail: `${applied} of ${probes.expectedMigrations} migrations applied${db.hasVector ? '' : ', pgvector missing'}`,
        fix: 'pnpm db:migrate',
      }
      : { id: 'migrations', label: 'Database schema', status: 'ok', detail: `${applied} migrations applied, pgvector enabled` });
  }

  const providers = activeProviders(probes.env);
  const cloud = providers.filter(p => p !== 'ollama');
  const models = await probes.ollamaModels();
  if (models === null) {
    add({ id: 'ollama', label: 'Ollama', status: 'fail', detail: `not reachable at ${probes.env.OLLAMA_URL || 'http://127.0.0.1:11434'}`, fix: 'ollama serve   (install: https://ollama.com)' });
  } else {
    add({ id: 'ollama', label: 'Ollama', status: 'ok', detail: `${models.length} models available` });
    const embed = probes.env.EMBED_MODEL || 'bge-m3';
    add(hasModel(models, embed)
      ? { id: 'embed-model', label: `Embedding model ${embed}`, status: 'ok', detail: 'pulled' }
      : { id: 'embed-model', label: `Embedding model ${embed}`, status: 'fail', detail: 'not pulled; embeddings always run locally', fix: `ollama pull ${embed}` });
    if (providers.includes('ollama')) {
      add(hasModel(models, LOCAL_CHAT_MODEL)
        ? { id: 'chat-model', label: `Local chat model ${LOCAL_CHAT_MODEL}`, status: 'ok', detail: 'pulled' }
        : {
          id: 'chat-model', label: `Local chat model ${LOCAL_CHAT_MODEL}`,
          // With a cloud key it is only the fallback; without one every evaluation needs it
          status: cloud.length > 0 ? 'warn' : 'fail',
          detail: cloud.length > 0 ? 'not pulled; only needed if the cloud providers fail' : 'not pulled; with no cloud key every evaluation needs it',
          fix: `ollama pull ${LOCAL_CHAT_MODEL}`,
        });
    }
  }

  const vaultPath = probes.env.VAULT_PATH || probes.demoVaultPath;
  const projects = await probes.vaultProjects(vaultPath);
  const usingDemo = !probes.env.VAULT_PATH;
  if (projects === null) {
    add({ id: 'vault', label: 'Obsidian vault', status: 'fail', detail: 'folder not found', fix: usingDemo ? 'Run Loom from the repository root' : 'Fix VAULT_PATH in .env, or remove it to use the demo vault' });
  } else if (projects.length === 0) {
    add({ id: 'vault', label: 'Obsidian vault', status: 'warn', detail: 'no project folders under Projects/ or Proyectos/', fix: 'Create a folder per project inside Projects/' });
  } else {
    add({ id: 'vault', label: 'Obsidian vault', status: 'ok', detail: `${projects.length} projects${usingDemo ? ' (demo vault)' : ''}` });
  }

  add(cloud.length === 0
    ? { id: 'providers', label: 'LLM providers', status: 'ok', detail: 'local only (Ollama); nothing leaves this machine' }
    : { id: 'providers', label: 'LLM providers', status: 'ok', detail: `${providers.join(' > ')}; article text and project notes are sent to ${cloud.join(' and ')}` });

  return results;
}

export function renderChecks(results: CheckResult[]): string {
  const mark = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]' } as const;
  const lines = results.map(r => {
    const base = `${mark[r.status]} ${r.label}: ${r.detail}`;
    return r.fix && r.status !== 'ok' ? `${base}\n         fix: ${r.fix}` : base;
  });
  const failures = results.filter(r => r.status === 'fail').length;
  lines.push('', failures === 0 ? 'Ready: all required checks passed.' : `${failures} required check${failures === 1 ? '' : 's'} failed.`);
  return lines.join('\n');
}

export const hasFailures = (results: CheckResult[]) => results.some(r => r.status === 'fail');
