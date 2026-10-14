import { PgBoss } from 'pg-boss';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 'postgres://loom:loompassword@localhost:5432/loomdb';

export const boss = new PgBoss(connectionString);

export const startQueue = async () => {
  boss.on('error', (error: any) => console.error('pg-boss error:', error));

  await boss.start();
  await boss.createQueue('ingest_url');
  await boss.createQueue('evaluate_content');
  await boss.createQueue('sync_suggestions');
  console.log('pg-boss started successfully');
};
