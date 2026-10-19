import * as path from 'path';
import { notesLanguage } from '../ai/language';

/**
 * The synthetic vault used when VAULT_PATH is unset: the Spanish or English copy, matching the
 * notes language (which follows the LANGUAGE preset unless NOTES_LANGUAGE is set).
 */
export function demoVaultPath(env: Record<string, string | undefined> = process.env, root = process.cwd()): string {
  return path.resolve(root, notesLanguage(env) === 'en' ? 'demo_vault_en' : 'demo_vault');
}
