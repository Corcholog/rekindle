import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { contents, evaluations, projectSnapshots, projects } from '../../db/schema';
import { eq, desc, sql, and } from 'drizzle-orm';
import { env, VECTOR_DISTANCE_THRESHOLD, MAX_INGEST_BODY_BYTES, MAX_ARTICLE_CHARS } from '../../config';
import { boss, INGEST_JOB_OPTIONS } from '../../queue';
import { newTraceId } from '../../observability/pipeline';

const PasteTextBodySchema = z.object({
  text: z.string().refine(t => t.trim().length > 0, { message: 'The pasted text is empty' }),
});

const IngestStatusSchema = z.enum(['pending', 'extracting', 'summarizing', 'embedding', 'ready', 'failed']);

const ContentItemSchema = z.object({
  id: z.string().uuid(),
  uri: z.string(),
  title: z.string().nullable(),
  channelOrDomain: z.string().nullable().optional(),
  ingestStatus: IngestStatusSchema,
  ingestStatusReason: z.string().nullable(),
  /** Why a failed ingest failed (src/workers/ingestFailure.ts); the UI explains it and offers to paste the text. */
  ingestFailureKind: z.enum(['pdf', 'unsupported_type', 'blocked', 'not_found', 'fetch_failed', 'no_text', 'too_little_text', 'no_transcript', 'not_allowed', 'other']).nullable().optional(),
  /** The owner pasted the text; the page was not fetched. */
  pastedText: z.boolean().optional(),
  consumedAt: z.string(),
  createdAt: z.string(),
  counts: z.object({
    evaluations: z.number(),
    actionable: z.number(),
    tentative: z.number().optional().default(0),
    irrelevant: z.number().optional().default(0),
    suggestions: z.number(),
  }),
  evaluationsList: z.array(z.object({
    projectId: z.string().uuid(),
    projectTitle: z.string(),
    verdict: z.enum(['irrelevant', 'tentative', 'actionable']).nullable(),
    confidenceScore: z.number().nullable(),
    triageReasoning: z.string().nullable(),
    /** Status of the suggestion this evaluation produced; null while a tentative one is unresolved. */
    suggestionStatus: z.enum(['pending', 'accepted', 'discarded']).nullable(),
  })).optional(),
  hasSpatialAffinity: z.boolean().optional(),
  isEvaluating: z.boolean().optional(),
});

const ContentDetailSchema = ContentItemSchema.extend({
  summary: z.string().nullable(),
  evaluations: z.array(z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    projectTitle: z.string(),
    verdict: z.enum(['irrelevant', 'tentative', 'actionable']).nullable(),
    confidenceScore: z.number().nullable(),
    triageReasoning: z.string().nullable(),
    evaluatedAt: z.string(),
  })),
});

const ListContentsQuerySchema = z.object({
  status: IngestStatusSchema.optional(),
  limit: z.coerce.number().min(1).max(100).default(30),
  offset: z.coerce.number().min(0).default(0),
});

const IdParamSchema = z.object({ id: z.string().uuid() });

// Correlated subqueries keep the list to a single round-trip
const evaluationsCount = sql<number>`(SELECT count(*)::int FROM evaluations WHERE evaluations.content_id = contents.id)`;
const actionableCount = sql<number>`(SELECT count(*)::int FROM evaluations WHERE evaluations.content_id = contents.id AND evaluations.verdict = 'actionable')`;
const tentativeCount = sql<number>`(SELECT count(*)::int FROM evaluations WHERE evaluations.content_id = contents.id AND evaluations.verdict = 'tentative')`;
const irrelevantCount = sql<number>`(SELECT count(*)::int FROM evaluations WHERE evaluations.content_id = contents.id AND evaluations.verdict = 'irrelevant')`;
const suggestionsCount = sql<number>`(SELECT count(*)::int FROM action_suggestions WHERE action_suggestions.content_id = contents.id)`;
let pgbossJobTableExists = false;

async function checkPgbossJobTable(): Promise<boolean> {
  if (pgbossJobTableExists) return true;
  try {
    const res = await db.execute(sql`SELECT to_regclass('pgboss.job') as tbl`);
    if (res.rows[0]?.tbl !== null) {
      pgbossJobTableExists = true;
    }
  } catch {
    // ignore
  }
  return pgbossJobTableExists;
}

const hasSpatialAffinitySql = sql<boolean>`EXISTS (
  SELECT 1 FROM (
    SELECT DISTINCT ON (ps.project_id) ps.embedding, ps.embedding_model
    FROM project_snapshots ps
    JOIN projects p ON ps.project_id = p.id
    WHERE p.is_active = true 
      AND ps.embedding IS NOT NULL 
    ORDER BY ps.project_id, ps.captured_at DESC
  ) latest_ps
  WHERE contents.embedding IS NOT NULL
    AND contents.embedding_model = ${env.EMBED_MODEL}
    AND latest_ps.embedding_model = ${env.EMBED_MODEL}
    AND latest_ps.embedding <=> contents.embedding < ${VECTOR_DISTANCE_THRESHOLD}
)`;

const evaluationsListSql = sql<any>`coalesce((
  SELECT json_agg(json_build_object(
    'projectId', p.id,
    'projectTitle', p.title,
    'verdict', e.verdict,
    'confidenceScore', e.confidence_score,
    'triageReasoning', e.triage_reasoning,
    'suggestionStatus', s.status
  ))
  FROM evaluations e
  JOIN project_snapshots ps ON e.project_snapshot_id = ps.id
  JOIN projects p ON ps.project_id = p.id
  LEFT JOIN action_suggestions s ON s.evaluation_id = e.id
  WHERE e.content_id = contents.id
), '[]'::json)`;

function getItemSelection(hasJobTable: boolean) {
  const isEvaluatingSql = hasJobTable 
    ? sql<boolean>`(
        contents.ingest_status IN ('extracting', 'summarizing', 'embedding')
        OR EXISTS (
          SELECT 1 FROM pgboss.job 
          WHERE name = 'evaluate_content' 
            AND data->>'contentId' = contents.id::text 
            AND state IN ('created', 'active', 'retry')
        )
      )`
    : sql<boolean>`(contents.ingest_status IN ('extracting', 'summarizing', 'embedding'))`;

  return {
    id: contents.id,
    uri: contents.uri,
    title: contents.title,
    channelOrDomain: contents.channelOrDomain,
    ingestStatus: contents.ingestStatus,
    ingestStatusReason: contents.ingestStatusReason,
    ingestFailureKind: contents.ingestFailureKind,
    pastedText: contents.pastedText,
    consumedAt: contents.consumedAt,
    createdAt: contents.createdAt,
    evaluationsCount,
    actionableCount,
    tentativeCount,
    irrelevantCount,
    suggestionsCount,
    isEvaluating: isEvaluatingSql,
    hasSpatialAffinity: hasSpatialAffinitySql,
    evaluationsList: evaluationsListSql,
  };
}

type ItemRow = {
  consumedAt: Date;
  createdAt: Date;
  evaluationsCount: number;
  actionableCount: number;
  tentativeCount?: number;
  irrelevantCount?: number;
  suggestionsCount: number;
  isEvaluating?: boolean;
  hasSpatialAffinity?: boolean;
  evaluationsList?: any;
  [key: string]: unknown;
};

function toItem<T extends ItemRow>(row: T) {
  const { 
    evaluationsCount: ev, 
    actionableCount: ac, 
    tentativeCount: tc,
    irrelevantCount: ic,
    suggestionsCount: sg, 
    isEvaluating: ie,
    hasSpatialAffinity: hsa,
    evaluationsList: el,
    ...rest 
  } = row;

  let parsedList = [];
  if (Array.isArray(el)) {
    parsedList = el;
  } else if (typeof el === 'string') {
    try { parsedList = JSON.parse(el); } catch { /* ignore JSON parse error */ }
  }

  return {
    ...rest,
    isEvaluating: Boolean(ie),
    hasSpatialAffinity: Boolean(hsa),
    consumedAt: row.consumedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    counts: { 
      evaluations: ev, 
      actionable: ac, 
      tentative: tc ?? 0,
      irrelevant: ic ?? 0,
      suggestions: sg 
    },
    evaluationsList: parsedList,
  };
}

export default async function (server: FastifyInstance) {
  // 1. List ingested contents (Inbox feed), newest first
  server.get('/api/contents', {
    schema: {
      querystring: ListContentsQuerySchema,
      response: {
        200: z.object({
          items: z.array(ContentItemSchema),
          total: z.number(),
          limit: z.number(),
          offset: z.number(),
        }),
      },
    },
  }, async (request, reply) => {
    const { status, limit, offset } = request.query as z.infer<typeof ListContentsQuerySchema>;
    const whereClause = status ? eq(contents.ingestStatus, status) : undefined;

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` })
      .from(contents)
      .where(whereClause);

    const hasJobTable = await checkPgbossJobTable();
    const itemSelection = getItemSelection(hasJobTable);

    const rows = await db.select(itemSelection)
      .from(contents)
      .where(whereClause)
      .orderBy(desc(contents.consumedAt))
      .limit(limit)
      .offset(offset);

    return reply.send({
      items: rows.map(toItem),
      total: countResult?.count ?? 0,
      limit,
      offset,
    });
  });

  // 2. Content detail: summary + per-project triage results
  server.get('/api/contents/:id', {
    schema: {
      params: IdParamSchema,
      response: {
        200: ContentDetailSchema,
        404: z.object({ error: z.string(), message: z.string(), code: z.string().optional() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof IdParamSchema>;

    const hasJobTable = await checkPgbossJobTable();
    const itemSelection = getItemSelection(hasJobTable);

    const [row] = await db.select({ ...itemSelection, summary: contents.summary })
      .from(contents)
      .where(eq(contents.id, id))
      .limit(1);

    if (!row) {
      return reply.status(404).send({ error: 'Not Found', message: `Content with id ${id} not found` });
    }

    const evals = await db.select({
      id: evaluations.id,
      projectId: projects.id,
      projectTitle: projects.title,
      verdict: evaluations.verdict,
      confidenceScore: evaluations.confidenceScore,
      triageReasoning: evaluations.triageReasoning,
      evaluatedAt: evaluations.evaluatedAt,
    })
    .from(evaluations)
    .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
    .innerJoin(projects, eq(projectSnapshots.projectId, projects.id))
    .where(eq(evaluations.contentId, id))
    .orderBy(desc(evaluations.evaluatedAt));

    return reply.send({
      ...toItem(row),
      evaluations: evals.map(e => ({ ...e, evaluatedAt: e.evaluatedAt.toISOString() })),
    });
  });

  // 3. The owner pastes the text of an item Rekindle could not read (a PDF, a blocked page, too
  // little text). Only a failed item takes it: one that was read and evaluated keeps its text (I6).
  // The text is untrusted like any page and is cut at MAX_ARTICLE_CHARS; the page is not fetched.
  server.post('/api/contents/:id/text', {
    bodyLimit: MAX_INGEST_BODY_BYTES,
    schema: {
      params: IdParamSchema,
      body: PasteTextBodySchema,
      response: {
        200: z.object({ contentId: z.string().uuid(), status: z.string() }),
        404: z.object({ error: z.string(), message: z.string(), code: z.string().optional() }),
        409: z.object({ error: z.string(), message: z.string(), code: z.string().optional() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof IdParamSchema>;
    const { text } = request.body as z.infer<typeof PasteTextBodySchema>;
    const [row] = await db.select({ id: contents.id, uri: contents.uri, title: contents.title, ingestStatus: contents.ingestStatus })
      .from(contents).where(eq(contents.id, id)).limit(1);
    if (!row) return reply.status(404).send({ error: 'Not Found', message: `Content with id ${id} not found`, code: 'content_not_found' });

    const traceId = newTraceId();
    const [updated] = await db.update(contents)
      .set({ rawText: text.trim().substring(0, MAX_ARTICLE_CHARS), pastedText: true, ingestStatus: 'pending', ingestStatusReason: null, ingestFailureKind: null, traceId })
      .where(and(eq(contents.id, id), eq(contents.ingestStatus, 'failed')))
      .returning({ id: contents.id });
    if (!updated) {
      return reply.status(409).send({ error: 'Conflict', message: 'Only an item that failed to ingest takes pasted text.', code: 'not_failed' });
    }
    await boss.send('ingest_url', { contentId: id, traceId, url: row.uri, initialTitle: row.title ?? undefined, pasted: true }, INGEST_JOB_OPTIONS);
    return reply.send({ contentId: id, status: 'pending' });
  });
}
