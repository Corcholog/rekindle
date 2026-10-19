import { spawn } from 'child_process';

// Development: rebuild the web UI on every change (vite build --watch) and restart the server on
// every change (tsx watch). Both are served from the same origin, as in production.
const children = [
  spawn('pnpm', ['exec', 'vite', 'build', '--config', 'web/vite.config.ts', '--watch'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('pnpm', ['exec', 'tsx', 'watch', 'scripts/run_server.ts'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', code => { if (code) stop(); });
