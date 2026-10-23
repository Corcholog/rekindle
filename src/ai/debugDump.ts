import * as fs from 'fs/promises';
import * as path from 'path';
import { ProviderError } from './types';
import { getLogger } from '../observability/logger';

const log = getLogger('ai');

/**
 * Opt-in, local only: with LLM_DEBUG_DIR set, an answer that could not be parsed is saved there
 * whole, to find out why a model writes broken JSON. It holds text derived from the owner's notes
 * and articles, so it is off by default, never logged or sent anywhere, and the folder should be
 * git-ignored (evals/private/ is). Read at call time, so a test or a one-off run can turn it on.
 */
export async function dumpFailedAnswer(provider: string, model: string, error: unknown, raw: string | null | undefined): Promise<void> {
  const dir = process.env.LLM_DEBUG_DIR;
  if (!dir || !(error instanceof ProviderError) || !['invalid_json', 'schema', 'empty'].includes(error.kind)) return;
  try {
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${provider}-${error.kind}-${Math.random().toString(36).slice(2, 8)}.json`);
    const entry = { provider, model, kind: error.kind, malformed: error.malformed ?? null, raw: raw ?? null };
    await fs.writeFile(file, JSON.stringify(entry, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    log.warn({ err }, 'Could not save the failed answer to LLM_DEBUG_DIR');
  }
}
