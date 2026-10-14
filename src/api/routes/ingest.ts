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
  title: z.string().optional(),
  selection: z.string().optional(),
});

export default async function (server: FastifyInstance) {
  // CORS Preflight Handler for Browser Bookmarklet & Web Clipper
  server.options('/api/ingest', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return reply.status(204).send();
  });

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
    reply.header('Access-Control-Allow-Origin', '*');
    const { url: rawUrl, title: passedTitle, selection } = request.body as { url: string; title?: string; selection?: string };
    const url = canonicalizeUrl(rawUrl);

    try {
      // Atomic upsert avoids race condition between concurrent requests
      const insertValues: any = {
        uri: url,
        ingestStatus: 'pending',
        consumedAt: new Date(),
      };
      if (passedTitle) {
        insertValues.title = passedTitle;
      }
      if (selection) {
        insertValues.rawText = selection;
      }

      const [record] = await db.insert(contents)
        .values(insertValues)
        .onConflictDoUpdate({
          target: contents.uri,
          set: {
            consumedAt: new Date(),
            ingestStatus: 'pending',
            ingestStatusReason: null,
            consumptionSeq: sql`${contents.consumptionSeq} + 1`,
            ...(passedTitle ? { title: passedTitle } : {}),
            ...(selection ? { rawText: selection } : {}),
          },
        })
        .returning({ id: contents.id, createdAt: contents.createdAt, consumedAt: contents.consumedAt });

      const contentId = record.id;
      // Consider new if created within the last 1000ms and matching consumedAt
      const isNew = Math.abs(record.consumedAt.getTime() - record.createdAt.getTime()) < 1000;

      // Enqueue job with singletonKey and retryLimit to prevent duplicate runs and infinite loops
      await boss.send('ingest_url', { 
        contentId, 
        url,
        initialTitle: passedTitle,
        selection,
      }, { singletonKey: contentId, retryLimit: 2 });

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
