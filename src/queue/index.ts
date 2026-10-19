import { PgBoss } from 'pg-boss';
import { env } from '../config';
import { getLogger } from '../observability/logger';

const log = getLogger('queue');

export const boss = new PgBoss(env.DATABASE_URL);

// The queues use pg-boss's standard policy, where singletonKey does not de-duplicate jobs. Duplicate
// or retried jobs are harmless because the handlers are idempotent: one evaluation per content and
// snapshot (unique index plus a check before any LLM call), and writeback markers in suggestions.md.
// Retries back off exponentially from retryDelay seconds: 30 s, 60 s, 120 s.
export const INGEST_JOB_OPTIONS = { retryLimit: 2, retryDelay: 30, retryBackoff: true };
export const EVALUATE_JOB_OPTIONS = { retryLimit: 3, retryDelay: 30, retryBackoff: true };
export const SYNC_JOB_OPTIONS = { retryLimit: 2, retryDelay: 10, retryBackoff: true };

export const startQueue = async () => {
  boss.on('error', (error: any) => log.error({ err: error }, 'pg-boss error'));

  await boss.start();
  await boss.createQueue('ingest_url');
  await boss.createQueue('evaluate_content');
  await boss.createQueue('sync_suggestions');
  log.info('pg-boss started');
};
