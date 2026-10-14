import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { contents } from '../../db/schema';
import { sql } from 'drizzle-orm';

const SystemStatusSchema = z.object({
  isProcessing: z.boolean(),
  totalActive: z.number(),
  evaluatingJobs: z.number(),
  ingestingJobs: z.number(),
  activeContents: z.number(),
  message: z.string(),
});

export default async function (server: FastifyInstance) {
  server.get('/api/system/status', {
    schema: {
      response: {
        200: SystemStatusSchema,
      },
    },
  }, async (request, reply) => {
    // 1. Query active / pending jobs in pgboss
    const jobsRes = await db.execute<{
      active_jobs: number;
      ingesting_jobs: number;
      evaluating_jobs: number;
    }>(sql`
      SELECT 
        count(*) filter (where state in ('created', 'active', 'retry'))::int as active_jobs,
        count(*) filter (where name = 'ingest_url' and state in ('created', 'active', 'retry'))::int as ingesting_jobs,
        count(*) filter (where name = 'evaluate_content' and state in ('created', 'active', 'retry'))::int as evaluating_jobs
      FROM pgboss.job
    `);
    const activeJobs = jobsRes.rows[0]?.active_jobs ?? 0;
    const ingestingJobs = jobsRes.rows[0]?.ingesting_jobs ?? 0;
    const evaluatingJobs = jobsRes.rows[0]?.evaluating_jobs ?? 0;

    // 2. Query contents in active ingestion phases
    const contentsRes = await db.select({
      count: sql<number>`count(*)::int`
    })
    .from(contents)
    .where(sql`ingest_status IN ('extracting', 'summarizing', 'embedding')`);
    const activeContents = contentsRes[0]?.count ?? 0;

    const totalActive = activeJobs + activeContents;
    const isProcessing = totalActive > 0;

    let message = 'En línea';
    if (evaluatingJobs > 0) {
      message = `Evaluando ${evaluatingJobs} contenido${evaluatingJobs === 1 ? '' : 's'} con IA...`;
    } else if (ingestingJobs > 0 || activeContents > 0) {
      message = `Procesando ingesta de enlaces...`;
    }

    return reply.send({
      isProcessing,
      totalActive,
      evaluatingJobs,
      ingestingJobs,
      activeContents,
      message,
    });
  });
}
