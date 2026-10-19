import { PgBoss } from 'pg-boss';
import { env } from '../config';
import { getLogger } from '../observability/logger';

const log = getLogger('queue');

export const boss = new PgBoss(env.DATABASE_URL);

export const startQueue = async () => {
  boss.on('error', (error: any) => log.error({ err: error }, 'pg-boss error'));

  await boss.start();
  await boss.createQueue('ingest_url');
  await boss.createQueue('evaluate_content');
  await boss.createQueue('sync_suggestions');
  log.info('pg-boss started');
};
