import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { actionSuggestions, projects, contents, evaluations, projectSnapshots } from '../../db/schema';
import { eq, and, or, sql, desc } from 'drizzle-orm';
import { writeAcceptedSuggestionToVault } from '../../vault/updater';
import { boss } from '../../queue';
import { sharedAiProvider } from '../../ai/OllamaProvider';
import { STALE_DRIFT_THRESHOLD } from '../../config';

const SuggestionItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  projectTitle: z.string().nullable().optional(),
  contentId: z.string().uuid(),
  contentTitle: z.string().nullable().optional(),
  contentUri: z.string().nullable().optional(),
  actionType: z.enum(['counter_argument', 'unblocker', 'evidence_citation', 'narrative_bridge', 'other']),
  targetFile: z.string(),
  observation: z.string(),
  suggestedAction: z.string(),
  status: z.enum(['pending', 'accepted', 'discarded', 'tentative']),
  userFeedback: z.string().nullable().optional(),
  writtenToVault: z.boolean(),
  resolvedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  triageReasoning: z.string().nullable().optional(),
  confidenceScore: z.number().nullable().optional(),
  isStale: z.boolean().default(false).optional(),
  driftScore: z.number().default(0).optional(),
});

const reevaluationSchema = z.object({
  resolution: z.enum(['keep_or_refine', 'already_addressed', 'obsolete']).describe(
    "Resolución de la sugerencia ante el borrador actual: 'keep_or_refine' si sigue aportando valor y debe mantenerse o pulirse; 'already_addressed' si el usuario ya redactó o incluyó esta idea en sus notas; 'obsolete' si el proyecto cambió de enfoque y la sugerencia ya no tiene sentido."
  ),
  reasoning: z.string().describe("Razonamiento detallado en español explicando la resolución."),
  refinedAction: z.object({
    actionType: z.enum(['counter_argument', 'unblocker', 'evidence_citation', 'narrative_bridge', 'other']),
    observation: z.string(),
    suggestedAction: z.string(),
    targetFile: z.string().nullish(),
  }).nullish().describe("Acción refinada obligatoria si resolution es 'keep_or_refine'. Debe ser null si resolution es 'already_addressed' o 'obsolete'."),
});

const SuggestionDetailSchema = SuggestionItemSchema.extend({
  contentSummary: z.string().nullable().optional(),
  triageVerdict: z.enum(['irrelevant', 'tentative', 'actionable']).nullable().optional(),
});

const ListSuggestionsQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  status: z.enum(['active', 'pending', 'accepted', 'discarded', 'tentative']).default('active'),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});

const UpdateSuggestionBodySchema = z.object({
  status: z.enum(['accepted', 'discarded']),
  userFeedback: z.string().max(1000).optional(),
});

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export default async function (server: FastifyInstance) {
  // 1. List Suggestions
  server.get('/api/suggestions', {
    schema: {
      querystring: ListSuggestionsQuerySchema,
      response: {
        200: z.object({
          items: z.array(SuggestionItemSchema),
          total: z.number(),
          limit: z.number(),
          offset: z.number(),
        }),
      },
    },
  }, async (request, reply) => {
    const { projectId, status, limit, offset } = request.query as z.infer<typeof ListSuggestionsQuerySchema>;
    const projectFilterA = projectId ? sql`AND a.project_id = ${projectId}` : sql``;
    const projectFilterE = projectId ? sql`AND ps.project_id = ${projectId}` : sql``;

    if (status === 'accepted') {
      const conds = [];
      if (projectId) conds.push(eq(actionSuggestions.projectId, projectId));
      conds.push(eq(actionSuggestions.status, 'accepted'));
      const where = and(...conds);

      const [totalRow] = await db.select({ count: sql<number>`count(*)::int` })
        .from(actionSuggestions)
        .where(where);
      const total = totalRow?.count ?? 0;

      const rows = await db.select({
        id: actionSuggestions.id,
        projectId: actionSuggestions.projectId,
        projectTitle: projects.title,
        contentId: actionSuggestions.contentId,
        contentTitle: contents.title,
        contentUri: contents.uri,
        actionType: actionSuggestions.actionType,
        targetFile: actionSuggestions.targetFile,
        observation: actionSuggestions.observation,
        suggestedAction: actionSuggestions.suggestedAction,
        status: actionSuggestions.status,
        userFeedback: actionSuggestions.userFeedback,
        writtenToVault: actionSuggestions.writtenToVault,
        resolvedAt: actionSuggestions.resolvedAt,
        createdAt: actionSuggestions.createdAt,
        confidenceScore: evaluations.confidenceScore,
        triageReasoning: evaluations.triageReasoning,
      })
      .from(actionSuggestions)
      .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
      .innerJoin(contents, eq(actionSuggestions.contentId, contents.id))
      .leftJoin(evaluations, eq(actionSuggestions.evaluationId, evaluations.id))
      .where(where)
      .orderBy(desc(actionSuggestions.createdAt))
      .limit(limit)
      .offset(offset);

      const paged = rows.map(r => ({
        ...r,
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        isStale: false,
        driftScore: 0,
      }));

      return reply.send({ items: paged, total, limit, offset });
    }

    if (status === 'pending') {
      const countRes = await db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count
        FROM action_suggestions a
        WHERE a.status = 'pending' ${projectFilterA}
      `);
      const total = countRes.rows[0]?.count ?? 0;

      const dataRes = await db.execute<{
        id: string;
        projectId: string;
        projectTitle: string;
        contentId: string;
        contentTitle: string;
        contentUri: string;
        actionType: any;
        targetFile: string;
        observation: string;
        suggestedAction: string;
        status: any;
        userFeedback: string | null;
        writtenToVault: boolean;
        resolvedAt: Date | string | null;
        createdAt: Date | string;
        confidenceScore: number | null;
        triageReasoning: string | null;
        driftScore: number;
        isStale: boolean;
      }>(sql`
        WITH latest_snapshots AS (
          SELECT DISTINCT ON (project_id) id, project_id, embedding, captured_at
          FROM project_snapshots
          ORDER BY project_id, captured_at DESC
        )
        SELECT
          a.id,
          a.project_id AS "projectId",
          p.title AS "projectTitle",
          a.content_id AS "contentId",
          c.title AS "contentTitle",
          c.uri AS "contentUri",
          a.action_type::text AS "actionType",
          a.target_file::text AS "targetFile",
          a.observation,
          a.suggested_action AS "suggestedAction",
          a.status::text AS status,
          a.user_feedback AS "userFeedback",
          a.written_to_vault AS "writtenToVault",
          a.resolved_at AS "resolvedAt",
          a.created_at AS "createdAt",
          e.confidence_score AS "confidenceScore",
          e.triage_reasoning AS "triageReasoning",
          COALESCE((ls.embedding <=> eval_ps.embedding)::float, 0.0) AS "driftScore",
          COALESCE(
            eval_ps.id != ls.id AND (
              COALESCE((ls.embedding <=> eval_ps.embedding) >= ${STALE_DRIFT_THRESHOLD}, false) OR
              (
                a.target_file != 'unknown' AND a.target_file != 'tentative' AND
                EXISTS (
                  SELECT 1 FROM project_note_snapshots pns_eval
                  LEFT JOIN project_note_snapshots pns_latest 
                    ON pns_latest.project_snapshot_id = ls.id 
                    AND (
                      pns_latest.note_path = pns_eval.note_path 
                      OR pns_latest.note_title = pns_eval.note_title
                      OR pns_latest.note_path LIKE '%/' || a.target_file
                    )
                  WHERE pns_eval.project_snapshot_id = eval_ps.id
                    AND (
                      pns_eval.note_path = a.target_file 
                      OR pns_eval.note_path = a.target_file || '.md'
                      OR pns_eval.note_title = a.target_file
                      OR pns_eval.note_path LIKE '%/' || a.target_file
                    )
                    AND (pns_latest.id IS NULL OR COALESCE((pns_latest.embedding <=> pns_eval.embedding) >= ${STALE_DRIFT_THRESHOLD}, false))
                )
              )
            ),
            false
          ) AS "isStale"
        FROM action_suggestions a
        JOIN projects p ON a.project_id = p.id
        JOIN contents c ON a.content_id = c.id
        LEFT JOIN evaluations e ON a.evaluation_id = e.id
        LEFT JOIN project_snapshots eval_ps ON e.project_snapshot_id = eval_ps.id
        LEFT JOIN latest_snapshots ls ON a.project_id = ls.project_id
        WHERE a.status = 'pending' ${projectFilterA}
        ORDER BY a.created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `);

      const paged = dataRes.rows.map(r => ({
        ...r,
        resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
        createdAt: new Date(r.createdAt).toISOString(),
        isStale: Boolean(r.isStale),
        driftScore: Number(r.driftScore || 0),
      }));

      return reply.send({ items: paged, total, limit, offset });
    }

    if (status === 'tentative') {
      const countRes = await db.execute<{ count: number }>(sql`
        WITH latest_project_evals AS (
          SELECT DISTINCT ON (e.content_id, ps.project_id)
            e.id, e.content_id, ps.project_id, e.verdict
          FROM evaluations e
          JOIN project_snapshots ps ON e.project_snapshot_id = ps.id
          WHERE 1=1 ${projectFilterE}
          ORDER BY e.content_id, ps.project_id, e.evaluated_at DESC
        )
        SELECT count(*)::int AS count
        FROM latest_project_evals lpe
        WHERE lpe.verdict = 'tentative'
          AND NOT EXISTS (
            SELECT 1 FROM action_suggestions a 
            WHERE a.evaluation_id = lpe.id
          )
      `);
      const total = countRes.rows[0]?.count ?? 0;

      const dataRes = await db.execute<{
        id: string;
        projectId: string;
        projectTitle: string;
        contentId: string;
        contentTitle: string;
        contentUri: string;
        actionType: any;
        targetFile: string;
        observation: string;
        suggestedAction: string;
        status: any;
        userFeedback: string | null;
        writtenToVault: boolean;
        resolvedAt: Date | string | null;
        createdAt: Date | string;
        confidenceScore: number | null;
        triageReasoning: string | null;
      }>(sql`
        WITH latest_project_evals AS (
          SELECT DISTINCT ON (e.content_id, ps.project_id)
            e.id,
            e.content_id,
            ps.project_id,
            e.verdict,
            e.confidence_score AS "confidenceScore",
            e.triage_reasoning AS "triageReasoning",
            e.evaluated_at AS "createdAt"
          FROM evaluations e
          JOIN project_snapshots ps ON e.project_snapshot_id = ps.id
          WHERE 1=1 ${projectFilterE}
          ORDER BY e.content_id, ps.project_id, e.evaluated_at DESC
        )
        SELECT
          lpe.id,
          lpe.project_id AS "projectId",
          p.title AS "projectTitle",
          c.id AS "contentId",
          c.title AS "contentTitle",
          c.uri AS "contentUri",
          'other'::text AS "actionType",
          'tentative'::text AS "targetFile",
          'Evaluación tentativa: relación temática o exploratoria'::text AS observation,
          COALESCE(lpe."triageReasoning", 'Aporte exploratorio sin acción concreta definida.')::text AS "suggestedAction",
          'tentative'::text AS status,
          NULL::text AS "userFeedback",
          false AS "writtenToVault",
          NULL::timestamp AS "resolvedAt",
          lpe."createdAt",
          lpe."confidenceScore",
          lpe."triageReasoning"
        FROM latest_project_evals lpe
        JOIN projects p ON lpe.project_id = p.id
        JOIN contents c ON lpe.content_id = c.id
        WHERE lpe.verdict = 'tentative'
          AND NOT EXISTS (
            SELECT 1 FROM action_suggestions a 
            WHERE a.evaluation_id = lpe.id
          )
        ORDER BY lpe."createdAt" DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `);

      const paged = dataRes.rows.map(r => ({
        ...r,
        resolvedAt: null,
        createdAt: new Date(r.createdAt).toISOString(),
        isStale: false,
        driftScore: 0,
      }));

      return reply.send({ items: paged, total, limit, offset });
    }

    // Combined queries for 'active' (pending + tentative) or 'discarded' (user discarded + LLM irrelevant)
    const isDiscarded = status === 'discarded';
    const evalVerdict = isDiscarded ? 'irrelevant' : 'tentative';
    const evalTarget = isDiscarded ? 'discarded' : 'tentative';
    const evalObs = isDiscarded 
      ? 'Descarte por modelo: no aporta evidencia ni argumentos a la tesis' 
      : 'Evaluación tentativa: relación temática o exploratoria';
    const evalDefaultAction = isDiscarded 
      ? 'Descartado por el modelo LLM' 
      : 'Aporte exploratorio sin acción concreta definida.';
    const finalEvalStatus = isDiscarded ? 'discarded' : 'tentative';

    const countRes = await db.execute<{ count: number }>(sql`
      WITH latest_project_evals AS (
        SELECT DISTINCT ON (e.content_id, ps.project_id)
          e.id, e.content_id, ps.project_id, e.verdict
        FROM evaluations e
        JOIN project_snapshots ps ON e.project_snapshot_id = ps.id
        WHERE 1=1 ${projectFilterE}
        ORDER BY e.content_id, ps.project_id, e.evaluated_at DESC
      ),
      combined AS (
        SELECT a.id
        FROM action_suggestions a
        WHERE a.status = ${isDiscarded ? 'discarded' : 'pending'} ${projectFilterA}
        UNION ALL
        SELECT lpe.id
        FROM latest_project_evals lpe
        WHERE lpe.verdict = ${evalVerdict}
          AND NOT EXISTS (
            SELECT 1 FROM action_suggestions s 
            WHERE s.evaluation_id = lpe.id
          )
      )
      SELECT count(*)::int AS count FROM combined
    `);
    const total = countRes.rows[0]?.count ?? 0;

    const dataRes = await db.execute<{
      id: string;
      projectId: string;
      projectTitle: string;
      contentId: string;
      contentTitle: string;
      contentUri: string;
      actionType: any;
      targetFile: string;
      observation: string;
      suggestedAction: string;
      status: any;
      userFeedback: string | null;
      writtenToVault: boolean;
      resolvedAt: Date | string | null;
      createdAt: Date | string;
      confidenceScore: number | null;
      triageReasoning: string | null;
      driftScore: number;
      isStale: boolean;
    }>(sql`
      WITH latest_snapshots AS (
        SELECT DISTINCT ON (project_id) id, project_id, embedding, captured_at
        FROM project_snapshots
        ORDER BY project_id, captured_at DESC
      ),
      latest_project_evals AS (
        SELECT DISTINCT ON (e.content_id, ps.project_id)
          e.id,
          e.content_id,
          ps.project_id,
          e.verdict,
          e.confidence_score AS "confidenceScore",
          e.triage_reasoning AS "triageReasoning",
          e.evaluated_at AS "createdAt"
        FROM evaluations e
        JOIN project_snapshots ps ON e.project_snapshot_id = ps.id
        WHERE 1=1 ${projectFilterE}
        ORDER BY e.content_id, ps.project_id, e.evaluated_at DESC
      ),
      combined AS (
        SELECT
          a.id,
          a.project_id AS "projectId",
          p.title AS "projectTitle",
          a.content_id AS "contentId",
          c.title AS "contentTitle",
          c.uri AS "contentUri",
          a.action_type::text AS "actionType",
          a.target_file::text AS "targetFile",
          a.observation,
          a.suggested_action AS "suggestedAction",
          a.status::text AS status,
          a.user_feedback AS "userFeedback",
          a.written_to_vault AS "writtenToVault",
          a.resolved_at AS "resolvedAt",
          a.created_at AS "createdAt",
          e.confidence_score AS "confidenceScore",
          e.triage_reasoning AS "triageReasoning",
          COALESCE((ls.embedding <=> eval_ps.embedding)::float, 0.0) AS "driftScore",
          COALESCE(
            ${!isDiscarded} AND eval_ps.id != ls.id AND (
              COALESCE((ls.embedding <=> eval_ps.embedding) >= ${STALE_DRIFT_THRESHOLD}, false) OR
              (
                a.target_file != 'unknown' AND a.target_file != 'tentative' AND
                EXISTS (
                  SELECT 1 FROM project_note_snapshots pns_eval
                  LEFT JOIN project_note_snapshots pns_latest 
                    ON pns_latest.project_snapshot_id = ls.id 
                    AND (
                      pns_latest.note_path = pns_eval.note_path 
                      OR pns_latest.note_title = pns_eval.note_title
                      OR pns_latest.note_path LIKE '%/' || a.target_file
                    )
                  WHERE pns_eval.project_snapshot_id = eval_ps.id
                    AND (
                      pns_eval.note_path = a.target_file 
                      OR pns_eval.note_path = a.target_file || '.md'
                      OR pns_eval.note_title = a.target_file
                      OR pns_eval.note_path LIKE '%/' || a.target_file
                    )
                    AND (pns_latest.id IS NULL OR COALESCE((pns_latest.embedding <=> pns_eval.embedding) >= ${STALE_DRIFT_THRESHOLD}, false))
                )
              )
            ),
            false
          ) AS "isStale"
        FROM action_suggestions a
        JOIN projects p ON a.project_id = p.id
        JOIN contents c ON a.content_id = c.id
        LEFT JOIN evaluations e ON a.evaluation_id = e.id
        LEFT JOIN project_snapshots eval_ps ON e.project_snapshot_id = eval_ps.id
        LEFT JOIN latest_snapshots ls ON a.project_id = ls.project_id
        WHERE a.status = ${isDiscarded ? 'discarded' : 'pending'} ${projectFilterA}

        UNION ALL

        SELECT
          lpe.id,
          lpe.project_id AS "projectId",
          p.title AS "projectTitle",
          c.id AS "contentId",
          c.title AS "contentTitle",
          c.uri AS "contentUri",
          'other'::text AS "actionType",
          ${evalTarget}::text AS "targetFile",
          ${evalObs}::text AS observation,
          COALESCE(lpe."triageReasoning", ${evalDefaultAction})::text AS "suggestedAction",
          ${finalEvalStatus}::text AS status,
          NULL::text AS "userFeedback",
          false AS "writtenToVault",
          NULL::timestamp AS "resolvedAt",
          lpe."createdAt",
          lpe."confidenceScore",
          lpe."triageReasoning",
          0.0::float AS "driftScore",
          false AS "isStale"
        FROM latest_project_evals lpe
        JOIN projects p ON lpe.project_id = p.id
        JOIN contents c ON lpe.content_id = c.id
        WHERE lpe.verdict = ${evalVerdict}
          AND NOT EXISTS (
            SELECT 1 FROM action_suggestions s 
            WHERE s.evaluation_id = lpe.id
          )
      )
      SELECT * FROM combined
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    const paged = dataRes.rows.map(r => ({
      ...r,
      resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
      createdAt: new Date(r.createdAt).toISOString(),
      isStale: Boolean(r.isStale),
      driftScore: Number(r.driftScore || 0),
    }));

    return reply.send({ items: paged, total, limit, offset });
  });

  // 2. Get Single Suggestion Detail
  server.get('/api/suggestions/:id', {
    schema: {
      params: IdParamSchema,
      response: {
        200: SuggestionDetailSchema,
        404: z.object({ error: z.string(), message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof IdParamSchema>;

    const rows = await db.select({
      id: actionSuggestions.id,
      projectId: actionSuggestions.projectId,
      projectTitle: projects.title,
      contentId: actionSuggestions.contentId,
      contentTitle: contents.title,
      contentUri: contents.uri,
      contentSummary: contents.summary,
      actionType: actionSuggestions.actionType,
      targetFile: actionSuggestions.targetFile,
      observation: actionSuggestions.observation,
      suggestedAction: actionSuggestions.suggestedAction,
      status: actionSuggestions.status,
      userFeedback: actionSuggestions.userFeedback,
      writtenToVault: actionSuggestions.writtenToVault,
      resolvedAt: actionSuggestions.resolvedAt,
      createdAt: actionSuggestions.createdAt,
      triageReasoning: evaluations.triageReasoning,
      triageVerdict: evaluations.verdict,
      confidenceScore: evaluations.confidenceScore,
    })
    .from(actionSuggestions)
    .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
    .innerJoin(contents, eq(actionSuggestions.contentId, contents.id))
    .leftJoin(evaluations, eq(actionSuggestions.evaluationId, evaluations.id))
    .where(or(eq(actionSuggestions.id, id), eq(actionSuggestions.evaluationId, id)))
    .limit(1);

    if (rows.length === 0) {
      // Check if it is an evaluation row (tentative or irrelevant)
      const evalRows = await db.select({
        id: evaluations.id,
        projectId: projectSnapshots.projectId,
        projectTitle: projects.title,
        contentId: contents.id,
        contentTitle: contents.title,
        contentUri: contents.uri,
        contentSummary: contents.summary,
        triageReasoning: evaluations.triageReasoning,
        triageVerdict: evaluations.verdict,
        confidenceScore: evaluations.confidenceScore,
        createdAt: evaluations.evaluatedAt,
      })
      .from(evaluations)
      .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
      .innerJoin(projects, eq(projectSnapshots.projectId, projects.id))
      .innerJoin(contents, eq(evaluations.contentId, contents.id))
      .where(eq(evaluations.id, id))
      .limit(1);

      if (evalRows.length > 0) {
        const ev = evalRows[0];
        const status = ev.triageVerdict === 'tentative' ? ('tentative' as const) : ('discarded' as const);
        return reply.send({
          id: ev.id,
          projectId: ev.projectId,
          projectTitle: ev.projectTitle,
          contentId: ev.contentId,
          contentTitle: ev.contentTitle,
          contentUri: ev.contentUri,
          contentSummary: ev.contentSummary,
          actionType: 'other' as const,
          targetFile: status,
          observation: status === 'tentative' ? 'Evaluación tentativa' : 'Descarte analítico',
          suggestedAction: ev.triageReasoning || '',
          status,
          userFeedback: null,
          writtenToVault: false,
          resolvedAt: null,
          createdAt: ev.createdAt.toISOString(),
          triageReasoning: ev.triageReasoning,
          triageVerdict: ev.triageVerdict,
          confidenceScore: ev.confidenceScore,
          isStale: false,
          driftScore: 0,
        });
      }

      return reply.status(404).send({
        error: 'Not Found',
        message: `Suggestion with id ${id} not found`,
      });
    }

    const item = rows[0];
    return reply.send({
      ...item,
      resolvedAt: item.resolvedAt ? item.resolvedAt.toISOString() : null,
      createdAt: item.createdAt.toISOString(),
      isStale: false,
      driftScore: 0,
    });
  });

  // A suggestion is re-linked to the new evaluation only if no other suggestion owns it
  // (evaluation_id is unique per suggestion).
  async function evaluationLink(newEvaluationId: string, suggestionId: string) {
    const [owner] = await db.select({ id: actionSuggestions.id })
      .from(actionSuggestions)
      .where(eq(actionSuggestions.evaluationId, newEvaluationId))
      .limit(1);
    return !owner || owner.id === suggestionId ? { evaluationId: newEvaluationId } : {};
  }

  // Re-evaluation execution helper
  async function executeReevaluation(suggestionId: string) {
    const [sug] = await db.select({
      id: actionSuggestions.id,
      projectId: actionSuggestions.projectId,
      contentId: actionSuggestions.contentId,
      actionType: actionSuggestions.actionType,
      observation: actionSuggestions.observation,
      suggestedAction: actionSuggestions.suggestedAction,
      targetFile: actionSuggestions.targetFile,
      status: actionSuggestions.status,
    })
    .from(actionSuggestions)
    .where(eq(actionSuggestions.id, suggestionId))
    .limit(1);

    if (!sug) {
      return { error: 'Not Found', statusCode: 404, message: `Sugerencia ${suggestionId} no encontrada.` };
    }

    if (sug.status !== 'pending') {
      return { error: 'Bad Request', statusCode: 400, message: `Solo se pueden re-evaluar sugerencias pendientes.` };
    }

    const [project] = await db.select().from(projects).where(eq(projects.id, sug.projectId)).limit(1);
    const [content] = await db.select().from(contents).where(eq(contents.id, sug.contentId)).limit(1);

    if (!project || !content) {
      return { error: 'Not Found', statusCode: 404, message: 'Proyecto o contenido asociado no encontrado.' };
    }

    const [latestSnapshot] = await db.select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, sug.projectId))
      .orderBy(desc(projectSnapshots.capturedAt))
      .limit(1);

    if (!latestSnapshot) {
      return { error: 'Bad Request', statusCode: 400, message: 'El proyecto no tiene ningún snapshot disponible para re-evaluar.' };
    }

    const projectNotes = latestSnapshot.notesContent || latestSnapshot.thesisText || 'Sin notas adicionales.';

    const systemPrompt = `Eres un asistente de redacción y análisis crítico en Obsidian. Tu misión es RE-EVALUAR una sugerencia previa a la luz de los cambios y notas más recientes del proyecto.
Debes responder SIEMPRE en ESPAÑOL.

REGLAS DE RESOLUCIÓN:
1. 'keep_or_refine': La sugerencia sigue siendo útil y válida. Si el borrador actual requiere ajustar el tipo de acción, la redacción, la observación o el archivo objetivo, actualízalos en 'refinedAction'.
2. 'already_addressed': El usuario ya escribió, citó o incorporó esta idea o evidencia en las notas actuales del proyecto. Ya no es necesaria. 'refinedAction' debe ser null.
3. 'obsolete': El proyecto cambió de enfoque, eliminó la sección relevante o la sugerencia ya no tiene sentido con la dirección actual. 'refinedAction' debe ser null.`;

    const userMessage = `<PREVIOUS_SUGGESTION>
- Tipo de acción: ${sug.actionType}
- Archivo objetivo original: ${sug.targetFile}
- Observación previa: ${sug.observation}
- Acción sugerida previa: ${sug.suggestedAction}
</PREVIOUS_SUGGESTION>

<PROJECT_CONTEXT_ACTUAL>
Proyecto: ${project.title}
NOTAS Y BORRADORES ACTUALES:
${projectNotes.substring(0, 15000)}
</PROJECT_CONTEXT_ACTUAL>

<ARTICLE_SUMMARY>
${(content.summary || '').substring(0, 10000)}
</ARTICLE_SUMMARY>

Determina con precisión si la sugerencia debe mantenerse/refinarse, si ya fue abordada en el texto, o si quedó obsoleta.`;

    const { data: evalResult } = await sharedAiProvider.evaluateContent(systemPrompt, userMessage, reevaluationSchema);

    let newEvaluationId: string;

    if (evalResult.resolution === 'keep_or_refine') {
      const [insertedEval] = await db.insert(evaluations).values({
        contentId: sug.contentId,
        projectSnapshotId: latestSnapshot.id,
        verdict: 'actionable',
        confidenceScore: 0.90,
        triageReasoning: evalResult.reasoning,
        consumptionSeq: content.consumptionSeq,
      }).onConflictDoUpdate({
        target: [evaluations.contentId, evaluations.projectSnapshotId, evaluations.consumptionSeq],
        set: {
          verdict: 'actionable',
          triageReasoning: evalResult.reasoning,
          evaluatedAt: new Date(),
        }
      }).returning({ id: evaluations.id });

      newEvaluationId = insertedEval.id;

      const refinedAction = evalResult.refinedAction;
      await db.update(actionSuggestions).set({
        ...(await evaluationLink(newEvaluationId, sug.id)),
        actionType: refinedAction?.actionType || sug.actionType,
        observation: refinedAction?.observation || sug.observation,
        suggestedAction: refinedAction?.suggestedAction || sug.suggestedAction,
        targetFile: refinedAction?.targetFile || sug.targetFile,
      }).where(eq(actionSuggestions.id, sug.id));

    } else {
      const isAddressed = evalResult.resolution === 'already_addressed';
      const reasonPrefix = isAddressed ? '[Ya abordado]' : '[Obsoleto tras cambios]';

      const [insertedEval] = await db.insert(evaluations).values({
        contentId: sug.contentId,
        projectSnapshotId: latestSnapshot.id,
        verdict: 'irrelevant',
        confidenceScore: isAddressed ? 0.20 : 0.10,
        triageReasoning: `${reasonPrefix}: ${evalResult.reasoning}`,
        consumptionSeq: content.consumptionSeq,
      }).onConflictDoUpdate({
        target: [evaluations.contentId, evaluations.projectSnapshotId, evaluations.consumptionSeq],
        set: {
          verdict: 'irrelevant',
          triageReasoning: `${reasonPrefix}: ${evalResult.reasoning}`,
          evaluatedAt: new Date(),
        }
      }).returning({ id: evaluations.id });

      newEvaluationId = insertedEval.id;

      const prefixTag = isAddressed 
        ? '[Ya abordado en el borrador actual]' 
        : '[Obsoleto tras cambios en el proyecto]';
      const updatedObs = sug.observation.startsWith(prefixTag) 
        ? sug.observation 
        : `${prefixTag} ${sug.observation}`;

      await db.update(actionSuggestions).set({
        ...(await evaluationLink(newEvaluationId, sug.id)),
        status: 'discarded',
        resolvedAt: new Date(),
        observation: updatedObs,
        userFeedback: evalResult.reasoning,
      }).where(eq(actionSuggestions.id, sug.id));
    }

    const [updatedRow] = await db.select({
      id: actionSuggestions.id,
      projectId: actionSuggestions.projectId,
      projectTitle: projects.title,
      contentId: actionSuggestions.contentId,
      contentTitle: contents.title,
      contentUri: contents.uri,
      actionType: actionSuggestions.actionType,
      targetFile: actionSuggestions.targetFile,
      observation: actionSuggestions.observation,
      suggestedAction: actionSuggestions.suggestedAction,
      status: actionSuggestions.status,
      userFeedback: actionSuggestions.userFeedback,
      writtenToVault: actionSuggestions.writtenToVault,
      resolvedAt: actionSuggestions.resolvedAt,
      createdAt: actionSuggestions.createdAt,
      confidenceScore: evaluations.confidenceScore,
      triageReasoning: evaluations.triageReasoning,
    })
    .from(actionSuggestions)
    .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
    .innerJoin(contents, eq(actionSuggestions.contentId, contents.id))
    .leftJoin(evaluations, eq(actionSuggestions.evaluationId, evaluations.id))
    .where(eq(actionSuggestions.id, sug.id))
    .limit(1);

    return {
      success: true,
      resolution: evalResult.resolution,
      reasoning: evalResult.reasoning,
      suggestion: {
        ...updatedRow,
        resolvedAt: updatedRow.resolvedAt ? updatedRow.resolvedAt.toISOString() : null,
        createdAt: updatedRow.createdAt.toISOString(),
        isStale: false,
        driftScore: 0,
      }
    };
  }

  // 4. Re-evaluate a single stale suggestion
  server.post('/api/suggestions/:id/reevaluate', {
    schema: {
      params: IdParamSchema,
      response: {
        200: z.object({
          success: z.boolean(),
          resolution: z.enum(['keep_or_refine', 'already_addressed', 'obsolete']),
          reasoning: z.string(),
          suggestion: SuggestionItemSchema,
        }),
        400: z.object({ error: z.string(), message: z.string() }),
        404: z.object({ error: z.string(), message: z.string() }),
        500: z.object({ error: z.string(), message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof IdParamSchema>;

    try {
      const outcome = await executeReevaluation(id);
      if ('error' in outcome) {
        return reply.status(outcome.statusCode as any).send({
          error: outcome.error,
          message: outcome.message,
        });
      }

      return reply.send(outcome);
    } catch (err: any) {
      server.log.error({ err }, `Error re-evaluating suggestion ${id}`);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: err.message || 'Error al re-evaluar la sugerencia con el modelo de IA.',
      });
    }
  });

  // 5. Batch re-evaluate all stale pending suggestions for a project
  server.post('/api/projects/:id/reevaluate-stale', {
    schema: {
      params: IdParamSchema,
      response: {
        200: z.object({
          success: z.boolean(),
          reevaluatedCount: z.number(),
          results: z.array(z.object({
            id: z.string(),
            resolution: z.enum(['keep_or_refine', 'already_addressed', 'obsolete']),
            reasoning: z.string(),
          })),
        }),
        404: z.object({ error: z.string(), message: z.string() }),
        500: z.object({ error: z.string(), message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id: projectId } = request.params as z.infer<typeof IdParamSchema>;

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) {
      return reply.status(404).send({ error: 'Not Found', message: `Proyecto ${projectId} no encontrado.` });
    }

    try {
      const staleRows = await db.execute<{ id: string }>(sql`
        WITH latest_snapshots AS (
          SELECT DISTINCT ON (project_id) id, project_id, embedding, captured_at
          FROM project_snapshots
          WHERE project_id = ${projectId}
          ORDER BY project_id, captured_at DESC
        )
        SELECT a.id
        FROM action_suggestions a
        JOIN evaluations e ON a.evaluation_id = e.id
        JOIN project_snapshots eval_ps ON e.project_snapshot_id = eval_ps.id
        JOIN latest_snapshots ls ON a.project_id = ls.project_id
        WHERE a.project_id = ${projectId}
          AND a.status = 'pending'
          AND COALESCE(
            eval_ps.id != ls.id AND (
              COALESCE((ls.embedding <=> eval_ps.embedding) >= ${STALE_DRIFT_THRESHOLD}, false) OR
              (
                a.target_file != 'unknown' AND a.target_file != 'tentative' AND
                EXISTS (
                  SELECT 1 FROM project_note_snapshots pns_eval
                  LEFT JOIN project_note_snapshots pns_latest 
                    ON pns_latest.project_snapshot_id = ls.id 
                    AND (
                      pns_latest.note_path = pns_eval.note_path 
                      OR pns_latest.note_title = pns_eval.note_title
                      OR pns_latest.note_path LIKE '%/' || a.target_file
                    )
                  WHERE pns_eval.project_snapshot_id = eval_ps.id
                    AND (
                      pns_eval.note_path = a.target_file 
                      OR pns_eval.note_path = a.target_file || '.md'
                      OR pns_eval.note_title = a.target_file
                      OR pns_eval.note_path LIKE '%/' || a.target_file
                    )
                    AND (pns_latest.id IS NULL OR COALESCE((pns_latest.embedding <=> pns_eval.embedding) >= ${STALE_DRIFT_THRESHOLD}, false))
                )
              )
            ),
            false
          ) = true
      `);

      const results: { id: string; resolution: 'keep_or_refine' | 'already_addressed' | 'obsolete'; reasoning: string }[] = [];

      for (const row of staleRows.rows) {
        try {
          const outcome = await executeReevaluation(row.id);
          if ('success' in outcome && outcome.success) {
            results.push({
              id: row.id,
              resolution: outcome.resolution as any,
              reasoning: outcome.reasoning as any,
            });
          }
        } catch (itemErr) {
          server.log.warn({ err: itemErr }, `Failed to re-evaluate stale suggestion ${row.id}`);
        }
      }

      return reply.send({
        success: true,
        reevaluatedCount: results.length,
        results,
      });
    } catch (err: any) {
      server.log.error({ err }, `Error in batch re-evaluation for project ${projectId}`);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: err.message || 'Error en la re-evaluación por lotes de sugerencias desactualizadas.',
      });
    }
  });

  // 3. Update Suggestion Status (Accept / Discard)
  // Only pending suggestions can be resolved. Repeating the same resolution is a no-op (200);
  // changing an already-resolved suggestion to a different status is rejected (409).
  server.patch('/api/suggestions/:id', {
    schema: {
      params: IdParamSchema,
      body: UpdateSuggestionBodySchema,
      response: {
        200: SuggestionItemSchema,
        404: z.object({ error: z.string(), message: z.string() }),
        409: z.object({ error: z.string(), message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof IdParamSchema>;
    const { status, userFeedback } = request.body as z.infer<typeof UpdateSuggestionBodySchema>;

    let [existing] = await db.select()
      .from(actionSuggestions)
      .where(or(eq(actionSuggestions.id, id), eq(actionSuggestions.evaluationId, id)))
      .limit(1);

    if (!existing) {
      // Check if it is an evaluation row (e.g. tentative)
      const [evalRow] = await db.select({
        id: evaluations.id,
        projectId: projectSnapshots.projectId,
        contentId: evaluations.contentId,
        triageReasoning: evaluations.triageReasoning,
        verdict: evaluations.verdict,
        confidenceScore: evaluations.confidenceScore,
        createdAt: evaluations.evaluatedAt,
      })
      .from(evaluations)
      .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
      .where(eq(evaluations.id, id))
      .limit(1);

      if (evalRow) {
        // Resolving a tentative evaluation creates its suggestion row. The unique index on
        // evaluation_id makes concurrent requests safe: only one insert wins.
        const resolution = status === 'accepted'
          ? {
            actionType: 'narrative_bridge' as const,
            targetFile: 'ideas.md',
            observation: 'Afinidad temática aceptada por el usuario',
            suggestedAction: evalRow.triageReasoning || 'Integrar conceptos clave en el proyecto',
          }
          : {
            actionType: 'other' as const,
            targetFile: 'discarded',
            observation: 'Descarte por el usuario',
            suggestedAction: evalRow.triageReasoning || 'Descarte analítico',
          };

        await db.insert(actionSuggestions).values({
          projectId: evalRow.projectId,
          contentId: evalRow.contentId,
          evaluationId: evalRow.id,
          ...resolution,
          status,
          userFeedback: userFeedback ?? null,
          writtenToVault: false,
          resolvedAt: new Date(),
        }).onConflictDoNothing({ target: actionSuggestions.evaluationId });

        [existing] = await db.select()
          .from(actionSuggestions)
          .where(eq(actionSuggestions.evaluationId, evalRow.id))
          .limit(1);
      }
    }

    if (!existing) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Suggestion with id ${id} not found`,
      });
    }

    if (existing.status === 'pending') {
      // Atomic transition: only one concurrent request can move it out of 'pending'
      const transitioned = await db.update(actionSuggestions)
        .set({
          status,
          userFeedback: userFeedback ?? existing.userFeedback,
          resolvedAt: new Date(),
        })
        .where(and(eq(actionSuggestions.id, existing.id), eq(actionSuggestions.status, 'pending')))
        .returning({ id: actionSuggestions.id });

      if (transitioned.length === 0) {
        // Lost a race with another request; fall through to the resolved-state checks below
        const [current] = await db.select().from(actionSuggestions).where(eq(actionSuggestions.id, existing.id)).limit(1);
        if (current.status !== status) {
          return reply.status(409).send({
            error: 'Conflict',
            message: `Suggestion was already resolved as '${current.status}'`,
          });
        }
      }
    } else if (existing.status !== status) {
      return reply.status(409).send({
        error: 'Conflict',
        message: `Suggestion was already resolved as '${existing.status}'`,
      });
    }

    // Writeback (idempotent: no-op if already written)
    if (status === 'accepted') {
      const vaultPath = process.env.VAULT_PATH;
      if (vaultPath) {
        try {
          await writeAcceptedSuggestionToVault(existing.id, vaultPath);
        } catch (vaultError) {
          server.log.error({ err: vaultError }, `Failed writing accepted suggestion ${existing.id} to vault; queued for retry`);
          await boss.send('sync_suggestions', { projectId: existing.projectId }, { singletonKey: `sync:${existing.projectId}`, retryLimit: 2 }).catch(() => {});
        }
      } else {
        server.log.warn(`VAULT_PATH not set; accepted suggestion ${existing.id} not written to vault`);
      }
    }

    const [updatedRow] = await db.select({
      id: actionSuggestions.id,
      projectId: actionSuggestions.projectId,
      projectTitle: projects.title,
      contentId: actionSuggestions.contentId,
      contentTitle: contents.title,
      contentUri: contents.uri,
      actionType: actionSuggestions.actionType,
      targetFile: actionSuggestions.targetFile,
      observation: actionSuggestions.observation,
      suggestedAction: actionSuggestions.suggestedAction,
      status: actionSuggestions.status,
      userFeedback: actionSuggestions.userFeedback,
      writtenToVault: actionSuggestions.writtenToVault,
      resolvedAt: actionSuggestions.resolvedAt,
      createdAt: actionSuggestions.createdAt,
      triageReasoning: evaluations.triageReasoning,
      confidenceScore: evaluations.confidenceScore,
    })
    .from(actionSuggestions)
    .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
    .innerJoin(contents, eq(actionSuggestions.contentId, contents.id))
    .leftJoin(evaluations, eq(actionSuggestions.evaluationId, evaluations.id))
    .where(eq(actionSuggestions.id, existing.id))
    .limit(1);

    return reply.send({
      ...updatedRow,
      resolvedAt: updatedRow.resolvedAt ? updatedRow.resolvedAt.toISOString() : null,
      createdAt: updatedRow.createdAt.toISOString(),
      isStale: false,
      driftScore: 0,
    });
  });
}
