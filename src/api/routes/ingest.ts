import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { contents } from '../../db/schema';
import { boss } from '../../queue';
import { canonicalizeUrl } from '../../workers/ingestionWorker';

const IngestRequestSchema = z.object({
  url: z.string().url().refine((val) => {
    try {
      const parsed = new URL(val);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, { message: 'Only http and https protocols are supported' }),
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
          },
        })
        .returning({ id: contents.id, createdAt: contents.createdAt, consumedAt: contents.consumedAt });

      const contentId = record.id;
      // Consider new if created within the last 1000ms and matching consumedAt
      const isNew = Math.abs(record.consumedAt.getTime() - record.createdAt.getTime()) < 1000;

      // Enqueue job with singletonKey to prevent duplicate in-flight processing for the same content
      await boss.send('ingest_url', { contentId, url }, { singletonKey: contentId });

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
