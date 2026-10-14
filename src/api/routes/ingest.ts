import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { contents } from '../../db/schema';
import { boss } from '../../queue';
import { canonicalizeUrl, isPrivateOrLoopbackHost } from '../../workers/ingestionWorker';
import { sql } from 'drizzle-orm';

const IngestRequestSchema = z.object({
  url: z.string().url().refine((val) => {
    try {
      const parsed = new URL(val);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return !isPrivateOrLoopbackHost(parsed.hostname);
    } catch {
      return false;
    }
  }, { message: 'Solo se admiten URLs públicas http y https (direcciones locales o privadas no permitidas)' }),
});

export default async function (server: FastifyInstance) {
  server.post('/api/ingest', {
    schema: {
      body: IngestRequestSchema,
      response: {
        202: z.object({
          message: z.string(),
          contentId: z.string().uuid(),
          status: z.string()
        }),
        200: z.object({
          message: z.string(),
          contentId: z.string().uuid(),
          status: z.string()
        }),
        400: z.object({
          error: z.string(),
          message: z.string().optional()
        }),
        500: z.object({
          error: z.string()
        })
      }
    }
  }, async (request, reply) => {
    const rawUrl = (request.body as { url: string }).url;
    const url = canonicalizeUrl(rawUrl);

    try {
      // Atomic upsert avoids race condition between concurrent requests
      const [record] = await db.insert(contents)
        .values({
          uri: url,
          ingestStatus: 'pending',
          consumedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: contents.uri,
          set: {
            consumedAt: new Date(),
            ingestStatus: 'pending',
            ingestStatusReason: null,
            consumptionSeq: sql`${contents.consumptionSeq} + 1`,
          },
        })
        .returning({ id: contents.id, createdAt: contents.createdAt, consumedAt: contents.consumedAt });

      const contentId = record.id;
      // Consider new if created within the last 1000ms and matching consumedAt
      const isNew = Math.abs(record.consumedAt.getTime() - record.createdAt.getTime()) < 1000;

      // Enqueue job with singletonKey and retryLimit to prevent duplicate runs and infinite loops
      await boss.send('ingest_url', { contentId, url }, { singletonKey: contentId, retryLimit: 2 });

      const statusCode = isNew ? 202 : 200;
      return reply.status(statusCode).send({
        message: isNew ? 'URL accepted for processing' : 'URL re-queued for processing',
        contentId,
        status: 'pending'
      });

    } catch (error) {
      server.log.error({ error }, 'Failed to ingest URL');
      return reply.status(500).send({ error: 'Failed to ingest URL' });
    }
  });
}
