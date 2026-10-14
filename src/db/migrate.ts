import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';

async function runMigrations() {
  console.log('Running migrations...');
  
  // Habilitar pgvector manualmente antes de correr migraciones
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
  console.log('Extension pgvector is ready.');

  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
  
  await pool.end();
  process.exit(0);
}

runMigrations().catch((err) => {
  console.error('Migration failed!', err);
  process.exit(1);
});
