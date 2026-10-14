import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { contents, evaluations, projectSnapshots, projects, actionSuggestions } from '../../db/schema';
import { eq, desc, sql } from 'drizzle-orm';

const IngestStatusSchema = z.enum(['pending', 'extracting', 'summarizing', 'embedding', 'ready', 'failed']);

const ContentItemSchema = z.object({
  id: z.string().uuid(),
  uri: z.string(),
  title: z.string().nullable(),
  channelOrDomain: z.string().nullable().optional(),
  ingestStatus: IngestStatusSchema,
  ingestStatusReason: z.string().nullable(),
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
    projectTitle: z.string(),
    verdict: z.enum(['irrelevant', 'tentative', 'actionable']).nullable(),
    confidenceScore: z.number().nullable(),
    triageReasoning: z.string().nullable(),
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
    SELECT DISTINCT ON (ps.project_id) ps.embedding
    FROM project_snapshots ps
    JOIN projects p ON ps.project_id = p.id
    WHERE p.is_active = true 
      AND ps.embedding IS NOT NULL 
    ORDER BY ps.project_id, ps.captured_at DESC
  ) latest_ps
  WHERE contents.embedding IS NOT NULL
    AND latest_ps.embedding <=> contents.embedding < 0.6
)`;

const evaluationsListSql = sql<any>`coalesce((
  SELECT json_agg(json_build_object(
    'projectTitle', p.title,
    'verdict', e.verdict,
    'confidenceScore', e.confidence_score,
    'triageReasoning', e.triage_reasoning
  ))
  FROM evaluations e
  JOIN project_snapshots ps ON e.project_snapshot_id = ps.id
  JOIN projects p ON ps.project_id = p.id
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
    try { parsedList = JSON.parse(el); } catch {}
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
        404: z.object({ error: z.string(), message: z.string() }),
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
}
