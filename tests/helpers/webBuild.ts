import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Tests that load the web UI need web/dist. Builds it when it is missing or older than any
// source file (CI builds it before the tests, so this is a no-op there).
const WEB = path.resolve(__dirname, '../../web');
const DIST_INDEX = path.join(WEB, 'dist', 'index.html');

function newestSource(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

export function ensureWebBuild(): void {
  const built = fs.existsSync(DIST_INDEX) ? fs.statSync(DIST_INDEX).mtimeMs : 0;
  if (built >= newestSource(WEB)) return;
  execFileSync('pnpm', ['exec', 'vite', 'build', '--config', path.join(WEB, 'vite.config.ts'), '--logLevel', 'error'], { stdio: 'inherit', cwd: path.resolve(WEB, '..') });
}

export const WEB_DIST = path.join(WEB, 'dist');
