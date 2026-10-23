import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { contents } from '../../db/schema';
import { boss, INGEST_JOB_OPTIONS } from '../../queue';
import { canonicalizeUrl, isPrivateOrLoopbackHost } from '../../workers/ingestionWorker';
import { newTraceId } from '../../observability/pipeline';
import { and, eq } from 'drizzle-orm';
import { MAX_INGEST_BODY_BYTES, MAX_ARTICLE_CHARS } from '../../config';

const IngestRequestSchema = z.object({
  url: z.string().url().refine((val) => {
    try {
      const parsed = new URL(val);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return !isPrivateOrLoopbackHost(parsed.hostname);
    } catch {
      return false;
    }
  }, { message: 'Only public http(s) URLs are accepted (no local or private addresses)' }),
  title: z.string().optional(),
  selection: z.string().optional(),
  /** The article's text, pasted by the owner: the page is not fetched (PDFs, blocked or script-built pages). */
  text: z.string().optional(),
});

export default async function (server: FastifyInstance) {
  server.post('/api/ingest', {
    // A larger body gets 413 before it is parsed; the extension cuts selections well below this
    bodyLimit: MAX_INGEST_BODY_BYTES,
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
          message: z.string().optional(),
          code: z.string().optional(),
        }),
        500: z.object({
          error: z.string()
        })
      }
    }
  }, async (request, reply) => {
    const { url: rawUrl, title: passedTitle, selection, text } = request.body as { url: string; title?: string; selection?: string; text?: string };
    const url = canonicalizeUrl(rawUrl);
    const pastedText = text?.trim() ? text.trim().substring(0, MAX_ARTICLE_CHARS) : null;

    try {
      // Each ingestion starts a trace that follows the content to its suggestions
      const traceId = newTraceId();
      const enqueue = (contentId: string) => boss.send('ingest_url', {
        contentId,
        traceId,
        url,
        initialTitle: passedTitle,
        selection,
        ...(pastedText ? { pasted: true } : {}),
      }, INGEST_JOB_OPTIONS);

      // New URL: the insert wins atomically, even with concurrent requests
      const [created] = await db.insert(contents)
        .values({
          uri: url,
          ingestStatus: 'pending',
          consumedAt: new Date(),
          traceId,
          ...(passedTitle ? { title: passedTitle } : {}),
          ...(pastedText ? { rawText: pastedText, pastedText: true } : selection ? { rawText: selection } : {}),
        })
        .onConflictDoNothing({ target: contents.uri })
        .returning({ id: contents.id });

      if (created) {
        await enqueue(created.id);
        return reply.status(202).send({
          message: 'URL accepted for processing',
          contentId: created.id,
          status: 'pending',
        });
      }

      // Known URL (invariant I6): never re-evaluate. Only an ingest that failed is retried;
      // otherwise just record that it was clipped again.
      const [retried] = await db.update(contents)
        .set({
          ingestStatus: 'pending',
          ingestStatusReason: null,
          ingestFailureKind: null,
          consumedAt: new Date(),
          traceId,
          ...(passedTitle ? { title: passedTitle } : {}),
          ...(pastedText ? { rawText: pastedText, pastedText: true } : selection ? { rawText: selection } : {}),
        })
        .where(and(eq(contents.uri, url), eq(contents.ingestStatus, 'failed')))
        .returning({ id: contents.id });

      if (retried) {
        await enqueue(retried.id);
        return reply.status(200).send({
          message: 'Retrying a URL that failed before',
          contentId: retried.id,
          status: 'pending',
        });
      }

      const [existing] = await db.update(contents)
        .set({ consumedAt: new Date() })
        .where(eq(contents.uri, url))
        .returning({ id: contents.id, ingestStatus: contents.ingestStatus });

      return reply.status(200).send({
        message: 'The URL is already in the library',
        contentId: existing.id,
        status: existing.ingestStatus,
      });

    } catch (error) {
      server.log.error({ error }, 'Failed to ingest URL');
      return reply.status(500).send({ error: 'Failed to ingest URL' });
    }
  });
}
