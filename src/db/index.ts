import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { env } from '../config';
import { getLogger } from '../observability/logger';

const log = getLogger('db');

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

// Prevent unhandled error events from crashing the process on idle client drops
pool.on('error', (err) => {
  log.error({ err }, 'Unexpected idle Postgres client error');
});

export const db = drizzle(pool, { schema });
