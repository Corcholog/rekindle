import chokidar from 'chokidar';
import * as path from 'path';
import { reconcileProject, bootReconcile } from './reconciler';
import { PROJECT_DIR_NAMES } from '../config';
import { validateVaultPath } from './config';
import { getLogger, pathKey } from '../observability/logger';

const log = getLogger('watcher');

// Manage timeouts for debouncing
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 3000;

let activeWatcher: ReturnType<typeof chokidar.watch> | null = null;

/** Paths the watcher never reacts to: hidden entries and Loom's own suggestions.md (invariant I4). */
export function shouldIgnoreVaultPath(vaultRoot: string, targetPath: string): boolean {
  const rel = path.relative(vaultRoot, targetPath).replace(/\\/g, '/');
  if (!rel || rel === '.') return false;
  // Ignore dot-directories or dot-files inside the vault (e.g. .obsidian, .trash)
  if (rel.split('/').some(segment => segment.startsWith('.'))) return true;
  // Ignore suggestions.md to avoid self-triggering loops
  return path.basename(targetPath) === 'suggestions.md';
}

export function isVaultWatcherActive(): boolean {
  return activeWatcher !== null;
}

export async function stopVaultWatcher(): Promise<void> {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  if (activeWatcher) {
    try {
      await activeWatcher.close();
      log.info('Stopped the live vault watcher');
    } catch (err) {
      log.error({ err }, 'Stopping the live vault watcher failed');
    } finally {
      activeWatcher = null;
    }
  }
}

export async function startVaultWatcher(vaultPath: string, runInitialReconcile = true): Promise<void> {
  const resolved = path.resolve(vaultPath.trim());

  // Stop any previously running watcher
  if (activeWatcher) {
    await stopVaultWatcher();
  }

  // Ensure path is accessible (and automatically mounts drive if needed on Linux)
  const validation = await validateVaultPath(resolved);
  if (!validation.isValid) {
    log.warn({ vault: pathKey(resolved) }, 'Configured vault path is not accessible; live watcher not started');
    return;
  }

  if (runInitialReconcile) {
    log.info({ vault: pathKey(resolved) }, 'Boot reconciliation started');
    await bootReconcile(resolved);
    log.info('Boot reconciliation finished; starting the live watcher');
  } else {
    log.info('Boot reconciliation skipped; starting the live watcher');
  }

  const watchPaths = PROJECT_DIR_NAMES.map(dir => path.join(resolved, dir));

  const watcher = chokidar.watch(watchPaths, {
    ignored: (targetPath: string) => shouldIgnoreVaultPath(resolved, targetPath),
    persistent: true,
    ignoreInitial: true, // we already did bootReconcile
  });

  const handleEvent = (filePath: string) => {
    // Only care about markdown files, ignore suggestions.md
    if (!filePath.endsWith('.md') || path.basename(filePath) === 'suggestions.md') return;

    // Derive path strictly relative to vault root
    const relFromVault = path.relative(resolved, filePath).replace(/\\/g, '/');
    if (relFromVault.startsWith('..') || path.isAbsolute(relFromVault)) return;

    const parts = relFromVault.split('/');
    if (parts.length < 2) return;

    const [topDir, projectName] = parts;
    if (!(PROJECT_DIR_NAMES as readonly string[]).includes(topDir)) return;
    if (!projectName) return;

    const projectPath = path.join(resolved, topDir, projectName);

    // Debounce logic
    if (debounceTimers.has(projectPath)) {
      clearTimeout(debounceTimers.get(projectPath));
    }

    const timer = setTimeout(() => {
      debounceTimers.delete(projectPath);
      log.info({ project: pathKey(projectPath) }, 'Project changed; reconciling');
      reconcileProject(projectPath, resolved).catch(err => log.error({ err, project: pathKey(projectPath) }, 'Reconciliation failed'));
    }, DEBOUNCE_MS);

    debounceTimers.set(projectPath, timer);
  };

  const handleUnlinkDir = async (dirPath: string) => {
    const relFromVault = path.relative(resolved, dirPath).replace(/\\/g, '/');
    if (relFromVault.startsWith('..') || path.isAbsolute(relFromVault)) return;

    const parts = relFromVault.split('/');
    if (parts.length === 2 && (PROJECT_DIR_NAMES as readonly string[]).includes(parts[0])) {
      const folderPath = `${parts[0]}/${parts[1]}`;
      try {
        const { db } = await import('../db');
        const { projects } = await import('../db/schema');
        const { eq } = await import('drizzle-orm');
        await db.update(projects).set({ isActive: false }).where(eq(projects.folderPath, folderPath));
        log.info({ project: pathKey(folderPath) }, 'Project folder removed; marked inactive');
      } catch (err) {
        log.error({ err }, 'Marking a removed project inactive failed');
      }
    }
  };

  watcher
    .on('add', handleEvent)
    .on('change', handleEvent)
    .on('unlink', handleEvent)
    .on('unlinkDir', handleUnlinkDir)
    .on('error', (err) => {
      log.error({ err }, 'File watcher error');
    });

  activeWatcher = watcher;

  log.info({ folders: PROJECT_DIR_NAMES, vault: pathKey(resolved) }, 'Watching the vault for project changes');
}

export async function restartVaultWatcher(vaultPath: string, runInitialReconcile = true): Promise<void> {
  await stopVaultWatcher();
  await startVaultWatcher(vaultPath, runInitialReconcile);
}
