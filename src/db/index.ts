import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { env } from '../config';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

// Prevent unhandled error events from crashing the process on idle client drops
pool.on('error', (err) => {
  console.error('[PgPool] Unexpected idle client error:', err);
});

export const db = drizzle(pool, { schema });
