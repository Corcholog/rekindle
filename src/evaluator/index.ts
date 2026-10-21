import { db } from '../db';
import { contents, projectSnapshots, projectNoteSnapshots, evaluations, actionSuggestions } from '../db/schema';
import { linkTelemetryToSuggestion } from '../observability/llmTelemetry';
import { eq, sql, and, desc } from 'drizzle-orm';
import { sharedAiProvider } from '../ai/aiProvider';
import { boss, EVALUATE_JOB_OPTIONS } from '../queue';
import { projectNotesContext, retrieveCandidates, retrieveWithStats, RetrievalOptions } from './retrieval';
import { resolveTarget } from './targetFile';
import { structureSuggestionText } from './structureText';
import { newTraceId, recordStage, errorKindOf } from '../observability/pipeline';
import { VECTOR_DISTANCE_THRESHOLD, PROMOTION_DELTA_THRESHOLD, NOTE_PROMOTION_DISTANCE_THRESHOLD, TOP_K_PROJECTS_LIMIT, env } from '../config';
import { getLogger } from '../observability/logger';
import { outputLanguage, promptLanguage } from '../ai/language';
import { serverText } from '../i18n/serverText';
import { idleDays } from '../vault/dormancy';
import { isDiscardAction, triageSchema, triageSystemPrompt, triageUserMessage } from './triagePrompt';

const log = getLogger('evaluator');

const ollama = sharedAiProvider;

/**
 * Main evaluation engine (2-Step Pipeline):
 * Step 1: Spatial Semantic Pre-filter (pgvector cosine distance < 0.6 in Postgres)
 * Step 2: Unified LLM Synthesis & Action Formulation (Single LLM invocation)
 */
export interface EvaluationTrace {
  /** Trace started at ingestion; a backlog or direct evaluation starts its own. */
  traceId?: string;
  /** pg-boss attempt of the job (1 = first run). */
  attempt?: number;
}

export interface EvaluationStats {
  traceId: string;
  outcome: 'evaluated' | 'not_found' | 'not_ready' | 'other_embedding_model' | 'no_candidates';
  candidates: number;
  evaluated: number;
  alreadyEvaluated: number;
  suggestions: number;
  failures: number;
}

export async function evaluateContentMatch(
  contentId: string,
  targetProjectId?: string,
  retrieval: RetrievalOptions = {},
  trace: EvaluationTrace = {},
): Promise<EvaluationStats> {
  const traceId = trace.traceId ?? newTraceId();
  const origin = trace.traceId ? 'ingest' : targetProjectId ? 'backlog' : 'direct';
  const started = Date.now();
  const stats: EvaluationStats = { traceId, outcome: 'evaluated', candidates: 0, evaluated: 0, alreadyEvaluated: 0, suggestions: 0, failures: 0 };
  const jobAttrs = () => {
    const { traceId: _traceId, ...counts } = stats;
    return { origin, targetProjectId, ...counts };
  };
  try {
    await runEvaluation(contentId, targetProjectId, retrieval, traceId, stats);
  } catch (err) {
    await recordStage({
      traceId, stage: 'evaluate_job', contentId, durationMs: Date.now() - started, ok: false,
      errorKind: errorKindOf(err), attempt: trace.attempt, attrs: jobAttrs(),
    });
    throw err;
  }
  await recordStage({
    traceId, stage: 'evaluate_job', contentId, durationMs: Date.now() - started,
    ok: stats.failures === 0, errorKind: stats.failures > 0 ? 'project_failures' : null,
    attempt: trace.attempt, attrs: jobAttrs(),
  });
  return stats;
}

async function runEvaluation(
  contentId: string,
  targetProjectId: string | undefined,
  retrieval: RetrievalOptions,
  traceId: string,
  stats: EvaluationStats,
): Promise<void> {
  log.info({ traceId, contentId, targetProjectId }, 'Evaluation started');
  
  // 1. Fetch content
  const contentRows = await db.select().from(contents).where(eq(contents.id, contentId));
  if (contentRows.length === 0) {
    stats.outcome = 'not_found';
    return;
  }
  
  const content = contentRows[0];
  if (!content.embedding || !content.summary) {
    log.info({ traceId, contentId }, 'Content has no embedding or summary yet; skipping');
    stats.outcome = 'not_ready';
    return;
  }

  // Invariant I7: only compare embeddings produced by the current model
  const embedModel = env.EMBED_MODEL;
  if (content.embeddingModel !== embedModel) {
    log.info({ traceId, contentId, contentModel: content.embeddingModel, embedModel }, 'Content embedded with another model; skipping');
    stats.outcome = 'other_embedding_model';
    return;
  }

  // Step 1: Vector Search: Find relevant project snapshots of active projects using distance threshold (< 0.6)
  const retrieveStarted = Date.now();
  const found = await retrieveWithStats(content.embedding, { ...retrieval, targetProjectId, embedModel });
  const candidates = found.candidates;
  stats.candidates = candidates.length;
  const retrievalEventId = await recordStage({
    traceId, stage: 'retrieve', contentId, durationMs: Date.now() - retrieveStarted,
    attrs: {
      threshold: found.threshold, limit: found.limit, embedModel, targetProjectId,
      withinThreshold: found.withinThreshold, returned: candidates.length,
      candidates: candidates.map((c, i) => ({
        rank: i + 1, projectId: c.projectId, snapshotId: c.snapshotId, noteSnapshotId: c.noteSnapshotId,
        level: c.level, distance: Number(c.distance.toFixed(4)),
      })),
    },
  });

  if (candidates.length === 0) {
    log.info({ traceId, contentId, threshold: found.threshold }, 'No project within the distance threshold');
    stats.outcome = 'no_candidates';
    return;
  }

  // Step 2: Unified Synthesis for each matching project (Single LLM Call)
  for (const [index, candidate] of candidates.entries()) {
    const rank = index + 1;
    const snapshotId = candidate.snapshotId;
    const projectId = candidate.projectId;
    const thesisText = candidate.thesisText;
    const matchedNotePath = candidate.notePath;
    const matchedNoteTitle = candidate.noteTitle;

    // Idempotency: Check if evaluation already exists before invoking LLM
    const [existing] = await db.select({ id: evaluations.id })
      .from(evaluations)
      .where(and(
        eq(evaluations.contentId, contentId),
        eq(evaluations.projectSnapshotId, snapshotId),
        eq(evaluations.consumptionSeq, content.consumptionSeq),
      ))
      .limit(1);

    if (existing) {
      log.info({ traceId, contentId, snapshotId }, 'Already evaluated; skipping');
      stats.alreadyEvaluated++;
      continue;
    }

    log.info({ traceId, contentId, snapshotId, rank, matchLevel: candidate.level, distance: candidate.distance }, 'Triage started');

    // Read at call time, so a language change in the settings applies to the next evaluation
    const languages = { prompt: promptLanguage(), output: outputLanguage() };
    const systemPrompt = triageSystemPrompt(languages);
    const notesContext = await projectNotesContext(snapshotId, content.embedding, candidate.notesContent, languages.prompt, embedModel);
    const userMessage = triageUserMessage(languages.prompt, {
      matchedNotePath, matchedNoteTitle, thesisText,
      projectNotes: notesContext.text,
      summary: (content.summary || '').substring(0, 10000),
    });

    const evaluateStarted = Date.now();
    const evaluateEvent = (ok: boolean, attrs: Record<string, unknown>, errorKind?: string) => recordStage({
      traceId, stage: 'evaluate', contentId, snapshotId, durationMs: Date.now() - evaluateStarted, ok, errorKind,
      attrs: { rank, projectId, distance: Number(candidate.distance.toFixed(4)), level: candidate.level, notesIncluded: notesContext.included, notesOmitted: notesContext.omitted, ...attrs },
    });
    try {
      const { data: result, model: modelUsed, telemetryIds = [] } = await ollama.evaluateContent(
        systemPrompt, userMessage, triageSchema(languages), undefined, { component: 'triage', traceId, contentId, snapshotId },
      );

      // Safety filter against paradoxical "discard" recommendations: stored as irrelevant
      const action = result.verdict === 'actionable' ? result.action : null;
      const suppressedDiscard = action !== null && isDiscardAction(action);
      const verdict = suppressedDiscard ? 'irrelevant' : result.verdict;
      const triageReasoning = suppressedDiscard
        ? `${result.triageReasoning}\n\n${serverText(languages.output).discardReasonLabel}: ${action!.observation || action!.suggestedAction}`.trim()
        : result.triageReasoning;
      if (suppressedDiscard) log.info({ traceId, projectId }, 'Suppressed a discard action; verdict set to irrelevant');

      const notes = await db.select({ path: projectNoteSnapshots.notePath, title: projectNoteSnapshots.noteTitle })
        .from(projectNoteSnapshots).where(eq(projectNoteSnapshots.projectSnapshotId, snapshotId));
      const target = action && !suppressedDiscard ? resolveTarget(action.targetFile, action.targetIsNew, notes, matchedNotePath) : null;
      // A second, short call lays out what the model wrote: the action as steps, the reasoning
      // connection first (structureText.ts). triage_reasoning keeps the model's own text; on a
      // failure the suggestion keeps its plain text
      const structured = verdict === 'tentative' || target
        ? await structureSuggestionText(ollama, {
          reasoning: result.triageReasoning,
          action: target ? { observation: action!.observation, suggestedAction: action!.suggestedAction, targetFile: target.path } : null,
          notes,
          output: languages.output,
        }, target, { traceId, contentId, snapshotId })
        : null;

      // The evaluation and its suggestion are written in one transaction. An interrupted job leaves
      // neither, so its retry evaluates the pair again; otherwise the retry would skip an
      // evaluation whose suggestion was never written.
      let written: { evaluationId: string; suggestionId: string | null };
      try {
        written = await db.transaction(async (tx) => {
          const [snapshotDates] = await tx.select({ notesModifiedAt: projectSnapshots.notesModifiedAt })
            .from(projectSnapshots).where(eq(projectSnapshots.id, snapshotId));
          const [evalRecord] = await tx.insert(evaluations).values({
            contentId,
            projectSnapshotId: snapshotId,
            projectIdleDays: idleDays(snapshotDates?.notesModifiedAt),
            matchedNotePath,
            verdict,
            confidenceScore: result.confidenceScore,
            triageReasoning,
            reasoningConnection: structured?.connection ?? null,
            reasoningGap: structured?.gap ?? null,
            consumptionSeq: content.consumptionSeq,
            traceId,
            retrievalEventId,
          }).returning({ id: evaluations.id });
          if (!action || !target) return { evaluationId: evalRecord.id, suggestionId: null };

          const [sugRecord] = await tx.insert(actionSuggestions).values({
            evaluationId: evalRecord.id,
            projectId,
            contentId,
            actionType: action.actionType,
            observation: action.observation,
            suggestedAction: structured?.headline ?? action.suggestedAction,
            actionSteps: structured?.headline ? structured.steps : null,
            targetFile: target.path,
            targetIsNew: target.isNew,
            status: 'pending',
          }).returning({ id: actionSuggestions.id });
          return { evaluationId: evalRecord.id, suggestionId: sugRecord.id };
        });
      } catch (insertError: any) {
        // A concurrent run of the same job evaluated this pair first (unique index)
        if ((insertError.code ?? insertError.cause?.code) === '23505') {
          log.info({ traceId, contentId, snapshotId }, 'Evaluation inserted concurrently; skipping');
          stats.alreadyEvaluated++;
          await evaluateEvent(true, { model: modelUsed, duplicate: true });
          continue;
        }
        throw insertError;
      }

      const { evaluationId: evalId, suggestionId } = written;
      stats.evaluated++;
      log.info({ traceId, projectId, model: modelUsed, verdict, confidence: result.confidenceScore, suggestionId }, 'Triage finished');
      if (suggestionId) {
        stats.suggestions++;
        await linkTelemetryToSuggestion(telemetryIds, suggestionId);
      }
      await evaluateEvent(true, {
        model: modelUsed, evaluationId: evalId, verdict, confidence: result.confidenceScore, suggestionId,
        ...(suppressedDiscard ? { suppressedDiscard: true } : {}),
      });
    } catch (err) {
      stats.failures++;
      await evaluateEvent(false, {}, errorKindOf(err));
      log.error({ err, traceId, contentId, snapshotId }, 'Triage failed for this project');
    }
  }
}

/**
 * Finds unevaluated ready contents whose embeddings match the project's thesis or any of its notes
 * (< 0.6 distance) and that rank the project among their closest TOP_K_PROJECTS_LIMIT, plus tentative
 * evaluations the project's latest snapshot moved closer to.
 */
export async function findBacklogUnevaluatedContents(projectId: string, limit = 100): Promise<string[]> {
  const [latestSnapshot] = await db.select({
    id: projectSnapshots.id,
    embedding: projectSnapshots.embedding,
    embeddingModel: projectSnapshots.embeddingModel,
  })
  .from(projectSnapshots)
  .where(and(
    eq(projectSnapshots.projectId, projectId),
    sql`${projectSnapshots.embedding} IS NOT NULL`
  ))
  .orderBy(desc(projectSnapshots.capturedAt))
  .limit(1);

  // Invariant I7: a snapshot from another model must be re-embedded before it is compared
  const embedModel = env.EMBED_MODEL;
  if (!latestSnapshot || latestSnapshot.embeddingModel !== embedModel) {
    return [];
  }

  const projectVector = latestSnapshot.embedding ? `[${latestSnapshot.embedding.join(',')}]` : null;

  const result = await db.execute<{ id: string }>(sql`
    WITH latest_snap AS (
      SELECT ${latestSnapshot.id}::uuid AS id, ${projectVector}::vector AS embedding
    ),
    latest_project_evals AS (
      SELECT DISTINCT ON (e.content_id)
        e.id, e.content_id, e.verdict, e.project_snapshot_id
      FROM ${evaluations} e
      JOIN ${projectSnapshots} ps ON e.project_snapshot_id = ps.id
      WHERE ps.project_id = ${projectId}
      ORDER BY e.content_id, e.evaluated_at DESC
    ),
    unevaluated_matches AS (
      SELECT c.id, c.consumed_at
      FROM ${contents} c, latest_snap ls
      WHERE c.ingest_status = 'ready'
        AND c.embedding IS NOT NULL
        AND c.embedding_model = ${embedModel}
        AND (
          ${projectVector ? sql`(c.embedding <=> ls.embedding < ${VECTOR_DISTANCE_THRESHOLD}) OR ` : sql``}
          EXISTS (
            SELECT 1 
            FROM ${projectNoteSnapshots} pns
            WHERE pns.project_snapshot_id = ls.id
              AND pns.embedding IS NOT NULL
              AND pns.embedding_model = ${embedModel}
              AND (c.embedding <=> pns.embedding) < ${VECTOR_DISTANCE_THRESHOLD}
          )
        )
        AND NOT EXISTS (
          SELECT 1 
          FROM ${evaluations} e
          JOIN ${projectSnapshots} ps ON e.project_snapshot_id = ps.id
          WHERE e.content_id = c.id
            AND ps.project_id = ${projectId}
        )
    ),
    tentative_promotions AS (
      SELECT c.id, c.consumed_at
      FROM ${contents} c
      JOIN latest_project_evals lpe ON lpe.content_id = c.id
      JOIN ${projectSnapshots} eval_ps ON lpe.project_snapshot_id = eval_ps.id
      JOIN latest_snap ls ON true
      WHERE lpe.verdict = 'tentative'
        AND eval_ps.id != ls.id
        AND c.embedding IS NOT NULL
        AND c.embedding_model = ${embedModel}
        AND eval_ps.embedding IS NOT NULL
        AND ls.embedding IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${actionSuggestions} a 
          WHERE a.content_id = c.id AND a.project_id = ${projectId}
        )
        AND (
          -- Project moved closer to content by at least PROMOTION_DELTA_THRESHOLD (0.08)
          (eval_ps.embedding_model = ${embedModel}
            AND (ls.embedding <=> c.embedding) <= (eval_ps.embedding <=> c.embedding) - ${PROMOTION_DELTA_THRESHOLD})
          OR
          -- A new or significantly updated note in latest_snap has strong affinity (< 0.50)
          EXISTS (
            SELECT 1 FROM ${projectNoteSnapshots} pns_new
            LEFT JOIN ${projectNoteSnapshots} pns_old
              ON pns_old.project_snapshot_id = eval_ps.id
              AND pns_old.note_path = pns_new.note_path
            WHERE pns_new.project_snapshot_id = ls.id
              AND pns_new.embedding IS NOT NULL
              AND pns_new.embedding_model = ${embedModel}
              AND (pns_new.embedding <=> c.embedding) < ${NOTE_PROMOTION_DISTANCE_THRESHOLD}
              AND (
                pns_old.id IS NULL
                OR pns_old.embedding IS NULL
                OR pns_old.embedding_model IS DISTINCT FROM ${embedModel}
                OR (pns_new.embedding <=> c.embedding) <= (pns_old.embedding <=> c.embedding) - 0.04
              )
          )
        )
    )
    SELECT id, bool_or(promotion) AS promotion, max(consumed_at) AS consumed_at FROM (
      SELECT id, consumed_at, false AS promotion FROM unevaluated_matches
      UNION ALL
      SELECT id, consumed_at, true AS promotion FROM tentative_promotions
    ) combined_candidates
    GROUP BY id
    ORDER BY consumed_at DESC
    LIMIT ${limit * BACKLOG_CANDIDATE_FACTOR}
  `);

  // An article never evaluated for this project goes to the model only if the project is among the
  // article's closest TOP_K_PROJECTS_LIMIT, the same cutoff as when it was clipped. Tentative
  // promotions were evaluated for this project already and moved closer, so they always qualify.
  const kept: string[] = [];
  for (const row of result.rows as unknown as { id: string; promotion: boolean }[]) {
    if (kept.length >= limit) break;
    if (row.promotion || await projectInTopK(row.id, projectId, embedModel)) kept.push(row.id);
  }
  return kept;
}

/** More candidates are read than enqueued, since the top-K check drops most of them. */
const BACKLOG_CANDIDATE_FACTOR = 5;

async function projectInTopK(contentId: string, projectId: string, embedModel: string): Promise<boolean> {
  const [content] = await db.select({ embedding: contents.embedding }).from(contents).where(eq(contents.id, contentId));
  if (!content?.embedding) return false;
  const closest = await retrieveCandidates(content.embedding, { limit: TOP_K_PROJECTS_LIMIT, embedModel });
  return closest.some(c => c.projectId === projectId);
}

/**
 * Option A: Automatically enqueues top relevant unevaluated past contents for a reactivated project.
 */
export async function enqueueProjectBacklogEvaluations(projectId: string, limit = 100): Promise<string[]> {
  const contentIds = await findBacklogUnevaluatedContents(projectId, limit);
  if (contentIds.length === 0) {
    return [];
  }

  log.info({ projectId, contents: contentIds.length }, 'Enqueueing backlog evaluations');

  for (const contentId of contentIds) {
    try {
      await boss.send('evaluate_content', { contentId, targetProjectId: projectId }, EVALUATE_JOB_OPTIONS);
    } catch (err) {
      log.warn({ err, projectId, contentId }, 'Could not enqueue a backlog evaluation');
    }
  }

  return contentIds;
}
