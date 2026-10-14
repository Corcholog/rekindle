import chokidar from 'chokidar';
import * as path from 'path';
import { reconcileProject, bootReconcile } from './reconciler';

// Manage timeouts for debouncing
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 3000;

let activeWatcher: ReturnType<typeof chokidar.watch> | null = null;
let activeVaultPath: string | null = null;

export function isVaultWatcherActive(): boolean {
  return activeWatcher !== null;
}

export function getActiveVaultWatcherPath(): string | null {
  return activeVaultPath;
}

export async function stopVaultWatcher(): Promise<void> {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  if (activeWatcher) {
    try {
      await activeWatcher.close();
      console.log(`[Watcher] Stopped live watcher for vault: ${activeVaultPath}`);
    } catch (err) {
      console.error(`[Watcher] Error stopping live watcher:`, err);
    } finally {
      activeWatcher = null;
      activeVaultPath = null;
    }
  }
}

export async function startVaultWatcher(vaultPath: string): Promise<void> {
  const resolved = path.resolve(vaultPath.trim());

  // Stop any previously running watcher
  if (activeWatcher) {
    await stopVaultWatcher();
  }

  console.log(`[Watcher] Starting initial boot reconciliation for vault: ${resolved}`);
  await bootReconcile(resolved);

  console.log(`[Watcher] Boot reconciliation finished. Starting live file watcher...`);

  const watchPaths = [
    path.join(resolved, 'Projects'),
    path.join(resolved, 'Proyectos')
  ];

  const watcher = chokidar.watch(watchPaths, {
    ignored: (targetPath: string) => {
      const rel = path.relative(resolved, targetPath).replace(/\\/g, '/');
      if (!rel || rel === '.') return false;
      // Ignore dot-directories or dot-files inside the vault (e.g. .obsidian, .trash)
      if (rel.split('/').some(segment => segment.startsWith('.'))) return true;
      // Ignore suggestions.md to avoid self-triggering loops
      if (path.basename(targetPath) === 'suggestions.md') return true;
      return false;
    },
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
    if (topDir !== 'Projects' && topDir !== 'Proyectos') return;
    if (!projectName) return;

    const projectPath = path.join(resolved, topDir, projectName);

    // Debounce logic
    if (debounceTimers.has(projectPath)) {
      clearTimeout(debounceTimers.get(projectPath));
    }

    const timer = setTimeout(() => {
      debounceTimers.delete(projectPath);
      console.log(`[Watcher] Detected changes in project ${projectName}. Reconciling...`);
      reconcileProject(projectPath, resolved).catch(console.error);
    }, DEBOUNCE_MS);

    debounceTimers.set(projectPath, timer);
  };

  const handleUnlinkDir = async (dirPath: string) => {
    const relFromVault = path.relative(resolved, dirPath).replace(/\\/g, '/');
    if (relFromVault.startsWith('..') || path.isAbsolute(relFromVault)) return;

    const parts = relFromVault.split('/');
    if (parts.length === 2 && (parts[0] === 'Projects' || parts[0] === 'Proyectos')) {
      const folderPath = `${parts[0]}/${parts[1]}`;
      try {
        const { db } = await import('../db');
        const { projects } = await import('../db/schema');
        const { eq } = await import('drizzle-orm');
        await db.update(projects).set({ isActive: false }).where(eq(projects.folderPath, folderPath));
        console.log(`[Watcher] Project directory removed: ${folderPath}. Marked as inactive.`);
      } catch (err) {
        console.error(`[Watcher] Error marking removed project as inactive:`, err);
      }
    }
  };

  watcher
    .on('add', handleEvent)
    .on('change', handleEvent)
    .on('unlink', handleEvent)
    .on('unlinkDir', handleUnlinkDir)
    .on('error', (err) => {
      console.error('[Watcher] File watcher encountered an error:', err);
    });

  activeWatcher = watcher;
  activeVaultPath = resolved;

  console.log(`[Watcher] Listening for changes in Projects/ and Proyectos/ at ${resolved}`);
}

export async function restartVaultWatcher(vaultPath: string): Promise<void> {
  await stopVaultWatcher();
  await startVaultWatcher(vaultPath);
}
