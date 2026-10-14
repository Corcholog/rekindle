import * as fs from 'fs/promises';
import * as path from 'path';
import { PROJECT_DIR_NAMES } from '../config';

export interface VaultPathStatus {
  vaultPath: string | null;
  isConfigured: boolean;
  isValid: boolean;
  hasProjectsDir: boolean;
  projectsDirName: string | null;
}

/**
 * Returns the currently active vault path.
 */
export function getCurrentVaultPath(): string | null {
  const p = process.env.VAULT_PATH;
  return p && p.trim().length > 0 ? path.resolve(p.trim()) : null;
}

/**
 * Validates a potential vault path on the filesystem.
 */
export async function validateVaultPath(candidatePath: string): Promise<VaultPathStatus> {
  if (!candidatePath || !candidatePath.trim()) {
    return {
      vaultPath: null,
      isConfigured: false,
      isValid: false,
      hasProjectsDir: false,
      projectsDirName: null,
    };
  }

  const resolved = path.resolve(candidatePath.trim());

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return {
        vaultPath: resolved,
        isConfigured: true,
        isValid: false,
        hasProjectsDir: false,
        projectsDirName: null,
      };
    }

    let hasProjectsDir = false;
    let projectsDirName: string | null = null;

    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && (PROJECT_DIR_NAMES as readonly string[]).includes(entry.name)) {
          hasProjectsDir = true;
          projectsDirName = entry.name;
          break;
        }
      }
    } catch {
      // If reading directory fails, still valid directory
    }

    return {
      vaultPath: resolved,
      isConfigured: true,
      isValid: true,
      hasProjectsDir,
      projectsDirName,
    };
  } catch {
    return {
      vaultPath: resolved,
      isConfigured: true,
      isValid: false,
      hasProjectsDir: false,
      projectsDirName: null,
    };
  }
}

/**
 * Updates and persists the vault path in memory and in the .env file.
 */
export async function persistVaultPath(newVaultPath: string): Promise<string> {
  const resolved = path.resolve(newVaultPath.trim());
  process.env.VAULT_PATH = resolved;

  // Never overwrite the real root .env file during automated test runs
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return resolved;
  }

  const envPath = path.resolve(process.cwd(), '.env');
  let envContent = '';

  try {
    envContent = await fs.readFile(envPath, 'utf-8');
  } catch {
    envContent = '';
  }

  const vaultLineRegex = /^VAULT_PATH=.*$/m;
  if (vaultLineRegex.test(envContent)) {
    envContent = envContent.replace(vaultLineRegex, `VAULT_PATH=${resolved}`);
  } else {
    envContent = envContent.trim() ? `${envContent.trim()}\nVAULT_PATH=${resolved}\n` : `VAULT_PATH=${resolved}\n`;
  }

  await fs.writeFile(envPath, envContent, 'utf-8');
  return resolved;
}
