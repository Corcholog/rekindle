import { pool } from '../db';
import { buildUserTestStats, renderUserTestStats } from './stats';

// pnpm usertest:stats [--json]
async function main() {
  const stats = await buildUserTestStats();
  console.log(process.argv.includes('--json') ? JSON.stringify(stats, null, 2) : renderUserTestStats(stats));
  await pool.end();
}

main().catch(err => {
  console.error('Could not read the database:', (err as { code?: string }).code ?? (err as Error).name);
  process.exit(1);
});
