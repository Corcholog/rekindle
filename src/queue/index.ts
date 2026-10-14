import { PgBoss } from 'pg-boss';
import { env } from '../config';

export const boss = new PgBoss(env.DATABASE_URL);

export const startQueue = async () => {
  boss.on('error', (error: any) => console.error('pg-boss error:', error));

  await boss.start();
  await boss.createQueue('ingest_url');
  await boss.createQueue('evaluate_content');
  await boss.createQueue('sync_suggestions');
  console.log('pg-boss started successfully');
};
