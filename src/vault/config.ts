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
 * Automatically mounts secondary NTFS/removable partitions on Linux via udisksctl
 * if the vault path resides on an unmounted /run/media drive.
 */
async function ensureDriveMountedIfLinuxMedia(candidatePath: string): Promise<void> {
  if (process.platform !== 'linux') return;
  const match = candidatePath.match(/\/run\/media\/[^/]+\/([0-9A-Fa-f]+)/);
  if (!match) return;

  try {
    const stat = await fs.stat(candidatePath);
    if (stat.isDirectory()) return;
  } catch {
    const uuid = match[1];
    try {
      const { execFile } = await import('child_process');
      await new Promise((resolve) => {
        execFile('udisksctl', ['mount', '-b', `/dev/disk/by-uuid/${uuid}`], () => resolve(null));
      });
    } catch {
      // Best-effort auto-mount
    }
  }
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
  await ensureDriveMountedIfLinuxMedia(resolved);

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

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A newline or other control character in a value would inject extra .env variables. */
export function isSafeEnvValue(value: string): boolean {
  return !CONTROL_CHARS.test(value);
}

/** Returns .env content with KEY set to value, replacing an existing line or appending one. */
export function upsertEnvLine(content: string, key: string, value: string): string {
  if (!isSafeEnvValue(value)) {
    throw new Error(`Invalid value for ${key}: control characters are not allowed`);
  }
  const line = `${key}=${value}`;
  const existing = new RegExp(`^${key}=.*$`, 'm');
  if (existing.test(content)) {
    // A replacer function keeps "$&", "$'" etc. in the value literal
    return content.replace(existing, () => line);
  }
  return content.trim() ? `${content.trimEnd()}\n${line}\n` : `${line}\n`;
}

/** Atomically rewrites one key in a .env file (temp file + rename), readable by the owner only. */
export async function writeEnvValue(envPath: string, key: string, value: string): Promise<void> {
  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf-8');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  const next = upsertEnvLine(content, key, value);
  const tmpPath = `${envPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, next, { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmpPath, envPath);
}

/**
 * Updates and persists the vault path in memory and in the .env file.
 */
export async function persistVaultPath(newVaultPath: string): Promise<string> {
  const resolved = path.resolve(newVaultPath.trim());
  if (!isSafeEnvValue(resolved)) {
    throw new Error('La ruta del vault contiene caracteres de control');
  }
  process.env.VAULT_PATH = resolved;

  // Never overwrite the real root .env file during automated test runs
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return resolved;
  }

  // Same location dotenv reads from
  await writeEnvValue(path.resolve(process.cwd(), '.env'), 'VAULT_PATH', resolved);
  return resolved;
}
