import { pool, db } from './index';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

async function resetDb() {
  console.log('Resetting Loom database to clean slate...');

  // Drop public, drizzle, and pgboss schemas to clear tables, migration history, and lingering jobs
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    DROP SCHEMA IF EXISTS pgboss CASCADE;
    CREATE EXTENSION IF NOT EXISTS vector;
  `);
  console.log('Schemas reset and pgvector extension initialized.');

  // Run all migrations to recreate clean tables
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Clean schema migrations successfully applied.');

  await pool.end();
  console.log('Database is fresh and ready.');
  process.exit(0);
}

resetDb().catch((err) => {
  console.error('Reset failed!', err);
  process.exit(1);
});
