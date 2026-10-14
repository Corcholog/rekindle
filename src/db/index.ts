import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://loom:loompassword@localhost:5432/loomdb',
});

// Prevent unhandled error events from crashing the process on idle client drops
pool.on('error', (err) => {
  console.error('[PgPool] Unexpected idle client error:', err);
});

export const db = drizzle(pool, { schema });
