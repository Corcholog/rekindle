import { db } from '../db';
import { contents, projectSnapshots, projectNoteSnapshots, evaluations, actionSuggestions, projects, llmTelemetry } from '../db/schema';
import { eq, sql, and, desc } from 'drizzle-orm';
import { sharedAiProvider } from '../ai/aiProvider';
import { boss } from '../queue';
import { z } from 'zod';
import { VECTOR_DISTANCE_THRESHOLD, TOP_K_PROJECTS_LIMIT, PROMOTION_DELTA_THRESHOLD, NOTE_PROMOTION_DISTANCE_THRESHOLD, env } from '../config';

const ollama = sharedAiProvider;

const evaluationActionSchema = z.object({
  actionType: z.enum(['counter_argument', 'unblocker', 'evidence_citation', 'narrative_bridge', 'other']).describe("Tipo de acción constructiva para Obsidian"),
  observation: z.string().describe("Observación específica de lo que aporta constructivamente el artículo al proyecto"),
  suggestedAction: z.string().describe("Instrucción concreta de redacción o integración en las notas de Obsidian (ej. citar en Acto 2, crear puente narrativo)."),
  targetFile: z.string().nullish().describe("Archivo de nota de Obsidian al que apunta la acción (ej. ideas.md o research/combat.md). Si no se especifica, se usará la nota con mayor afinidad."),
});

const unifiedEvaluationSchema = z.object({
  verdict: z.enum(['actionable', 'tentative', 'irrelevant']).describe(
    "Veredicto: 'actionable' si aporta ideas, citas o argumentos concretos para enriquecer el borrador; 'tentative' si es tangencial o dudoso; 'irrelevant' si no aporta nada o está fuera de foco."
  ),
  confidenceScore: z.number().min(0).max(1).describe("Puntaje decimal entre 0.0 y 1.0 que mide el grado de afinidad temática y relevancia con el proyecto: 0.0-0.3 si es irrelevant, 0.4-0.6 si es tentative, 0.7-1.0 si es actionable."),
  triageReasoning: z.string().describe("Razonamiento detallado en español explicando por qué es útil o por qué es irrelevante"),
  action: evaluationActionSchema.nullable().describe("Propuesta de acción concreta. REQUERIDO si verdict es 'actionable'. Debe ser null si verdict es 'tentative' o 'irrelevant'."),
});

/**
 * Main evaluation engine (2-Step Pipeline):
 * Step 1: Spatial Semantic Pre-filter (pgvector cosine distance < 0.6 in Postgres)
 * Step 2: Unified LLM Synthesis & Action Formulation (Single LLM invocation)
 */
export async function evaluateContentMatch(contentId: string, targetProjectId?: string) {
  console.log(`[Evaluator] Starting unified evaluation for content ${contentId}${targetProjectId ? ` (target project: ${targetProjectId})` : ''}`);
  
  // 1. Fetch content
  const contentRows = await db.select().from(contents).where(eq(contents.id, contentId));
  if (contentRows.length === 0) return;
  
  const content = contentRows[0];
  if (!content.embedding || !content.summary) {
    console.log(`[Evaluator] Content ${contentId} missing embedding or summary. Aborting.`);
    return;
  }

  // Invariant I7: only compare embeddings produced by the current model
  const embedModel = env.EMBED_MODEL;
  if (content.embeddingModel !== embedModel) {
    console.log(`[Evaluator] Content ${contentId} was embedded with ${content.embeddingModel ?? 'an unknown model'}, not ${embedModel}. Skipping.`);
    return;
  }

  // Step 1: Vector Search: Find relevant project snapshots of active projects using distance threshold (< 0.6)
  const targetVector = `[${content.embedding.join(',')}]`;
  const projectFilter = targetProjectId ? sql`AND p.id = ${targetProjectId}` : sql``;

  const topSnapshots = await db.execute(sql`
    WITH latest_snapshots AS (
      SELECT DISTINCT ON (project_id) id, project_id, thesis_text, notes_content, embedding, embedding_model, captured_at
      FROM ${projectSnapshots}
      ORDER BY project_id, captured_at DESC
    ),
    matching_notes AS (
      SELECT DISTINCT ON (pns.project_id)
        pns.project_id,
        pns.note_path,
        pns.note_title,
        pns.content_snippet,
        (pns.embedding <=> ${targetVector}::vector) AS note_distance
      FROM ${projectNoteSnapshots} pns
      JOIN latest_snapshots ls ON pns.project_snapshot_id = ls.id
      WHERE pns.embedding IS NOT NULL
        AND pns.embedding_model = ${embedModel}
        AND (pns.embedding <=> ${targetVector}::vector) < ${VECTOR_DISTANCE_THRESHOLD}
      ORDER BY pns.project_id, (pns.embedding <=> ${targetVector}::vector) ASC
    )
    SELECT 
      ls.id AS snapshot_id,
      ls.project_id,
      ls.thesis_text,
      ls.notes_content,
      mn.note_path AS matched_note_path,
      mn.note_title AS matched_note_title,
      mn.content_snippet AS matched_note_snippet,
      COALESCE(mn.note_distance, (ls.embedding <=> ${targetVector}::vector)) AS best_distance
    FROM latest_snapshots ls
    JOIN ${projects} p ON ls.project_id = p.id
    LEFT JOIN matching_notes mn ON ls.project_id = mn.project_id
    WHERE p.is_active = true
      ${projectFilter}
      AND (
        mn.note_path IS NOT NULL 
        OR (ls.embedding IS NOT NULL AND ls.embedding_model = ${embedModel} AND (ls.embedding <=> ${targetVector}::vector) < ${VECTOR_DISTANCE_THRESHOLD})
      )
    ORDER BY best_distance ASC
    LIMIT ${TOP_K_PROJECTS_LIMIT}
  `);

  if (topSnapshots.rows.length === 0) {
    console.log(`[Evaluator] [Step 1 Filtered] No matching active projects within distance threshold for content ${contentId}.`);
    return;
  }

  // Step 2: Unified Synthesis for each matching project (Single LLM Call)
  for (const row of topSnapshots.rows) {
    const snapshotId = (row.snapshot_id || row.id) as string;
    const projectId = row.project_id as string;
    const thesisText = row.thesis_text as string;
    const notesContent = (row.notes_content as string) || '';
    const matchedNotePath = (row.matched_note_path as string) || null;
    const matchedNoteTitle = (row.matched_note_title as string) || null;
    const matchedNoteSnippet = (row.matched_note_snippet as string) || null;

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
      console.log(`[Evaluator] Evaluation already exists for content ${contentId} and snapshot ${snapshotId}. Skipping.`);
      continue;
    }

    console.log(`[Evaluator] [Step 2 Synthesizing] Evaluating against Project Snapshot ${snapshotId} (focal note: ${matchedNotePath || 'project-level'})...`);

    const systemPrompt = `Eres un asistente de investigación y redacción crítico y constructivo. Tu misión es analizar si el ARTÍCULO aporta valor real, ideas nuevas o evidencia útil a los BORRADORES Y NOTAS DEL PROYECTO.
Debes responder SIEMPRE en ESPAÑOL.

REGLAS DE EVALUACIÓN:
1. 'actionable': ÚSALO SOLAMENTE si encuentras una forma concreta y útil de integrar el artículo en las notas (citar evidencia, contraargumento, puente narrativo entre actos). Si es 'actionable', el objeto 'action' DEBE estar completo con una acción constructiva. ¡NUNCA sugieras 'descartar'!
2. 'tentative': El contenido tiene relación temática pero no ofrece una contribución clara ni prioritaria. El campo 'action' debe ser null.
3. 'irrelevant': El artículo trata otro tema, no aporta nada o debe ser ignorado. El campo 'action' debe ser null.

[MUY IMPORTANTE]: El campo 'confidenceScore' DEBE ser un número decimal entre 0.0 y 1.0 que cuantifique la afinidad con el proyecto: 0.0 a 0.3 si es 'irrelevant', 0.4 a 0.6 si es 'tentative', y 0.7 a 1.0 si es 'actionable'.`;

    // Cap context strings to prevent overflowing model token limits
    const cappedProjectNotes = notesContent.substring(0, 15000);
    const cappedSummary = (content.summary || '').substring(0, 10000);

    let matchedNoteContext = '';
    if (matchedNotePath) {
      matchedNoteContext = `\nNOTA CON MAYOR AFINIDAD SEMÁNTICA DETECTADA:\n- Archivo: ${matchedNotePath}${matchedNoteTitle ? ` ("${matchedNoteTitle}")` : ''}\n${matchedNoteSnippet ? `- Extracto relevante:\n${matchedNoteSnippet}\n` : ''}`;
    }

    const userMessage = `<PROJECT_CONTEXT>
${matchedNoteContext}
NOTAS Y BORRADORES DEL PROYECTO:
${cappedProjectNotes || thesisText || 'Proyecto sin notas adicionales.'}
</PROJECT_CONTEXT>

<ARTICLE_SUMMARY>
${cappedSummary}
</ARTICLE_SUMMARY>

Por favor, evalúa de manera crítica la afinidad y propuesta constructiva siguiendo las reglas estructuradas.`;

    const startTime = Date.now();
    try {
      const { data: result, model: modelUsed } = await ollama.evaluateContent(systemPrompt, userMessage, unifiedEvaluationSchema);
      const latencyMs = Date.now() - startTime;
      
      // 1. Record Evaluation in DB
      let evalId: string;
      try {
        const [evalRecord] = await db.insert(evaluations).values({
          contentId,
          projectSnapshotId: snapshotId,
          verdict: result.verdict,
          confidenceScore: result.confidenceScore,
          triageReasoning: result.triageReasoning,
          consumptionSeq: content.consumptionSeq,
        }).returning({ id: evaluations.id });
        evalId = evalRecord.id;
      } catch (insertError: any) {
        if (insertError.code === '23505') {
          console.log(`[Evaluator] Evaluation already exists for this content and snapshot.`);
          continue;
        }
        console.error(`[Evaluator] Error inserting evaluation:`, insertError);
        throw insertError;
      }

      console.log(`[Evaluator] Result for Project ${projectId} via ${modelUsed}: ${result.verdict} (${Math.round((result.confidenceScore || 0) * 100)}%)`);

      // 2. If actionable and action details provided, record Action Suggestion
      let suggestionId: string | null = null;
      if (result.verdict === 'actionable' && result.action) {
        const actionTextLower = (result.action.suggestedAction || '').toLowerCase().trim();
        const obsLower = (result.action.observation || '').toLowerCase().trim();

        // Safety filter against paradoxical "discard" recommendations
        if (
          actionTextLower.startsWith('descartar') ||
          actionTextLower.includes('descartar el artículo') ||
          actionTextLower.includes('no incluir') ||
          (result.action.actionType === 'other' && obsLower.includes('no aporta'))
        ) {
          console.log(`[Evaluator] Suppressed paradoxical discard action. Updating verdict to irrelevant.`);
          const enhancedReason = `${result.triageReasoning}\n\n[Motivo de descarte]: ${result.action.observation || result.action.suggestedAction}`.trim();
          await db.update(evaluations).set({ 
            verdict: 'irrelevant',
            triageReasoning: enhancedReason,
          }).where(eq(evaluations.id, evalId));
          continue;
        }

        const resolvedTargetFile = result.action.targetFile || matchedNotePath || 'ideas.md';

        const [sugRecord] = await db.insert(actionSuggestions).values({
          evaluationId: evalId,
          projectId: projectId,
          contentId: contentId,
          actionType: result.action.actionType,
          observation: result.action.observation,
          suggestedAction: result.action.suggestedAction,
          targetFile: resolvedTargetFile,
          status: 'pending',
        }).returning({ id: actionSuggestions.id });
        suggestionId = sugRecord.id;
        
        console.log(`[Evaluator] Action suggestion created for Project ${projectId} targeting "${resolvedTargetFile}" (pending user review)`);
      }

      // 3. Record LLM Telemetry
      try {
        await db.insert(llmTelemetry).values({
          component: 'triage',
          contentId,
          snapshotId,
          suggestionId,
          modelName: modelUsed,
          latencyMs,
          isSuccess: true,
        });
      } catch {
        // Telemetry errors should not fail evaluation
      }
    } catch (err) {
      console.error(`[Evaluator] Error evaluating snapshot ${snapshotId} against content ${contentId}:`, err);
    }
  }
}

/**
 * Finds unevaluated ready contents whose embeddings match the project's thesis or any of its notes (< 0.6 distance).
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
    SELECT id FROM (
      SELECT id, consumed_at FROM unevaluated_matches
      UNION
      SELECT id, consumed_at FROM tentative_promotions
    ) combined_candidates
    ORDER BY consumed_at DESC
    LIMIT ${limit}
  `);

  return result.rows.map(r => r.id as string);
}

/**
 * Option A: Automatically enqueues top relevant unevaluated past contents for a reactivated project.
 */
export async function enqueueProjectBacklogEvaluations(projectId: string, limit = 100): Promise<string[]> {
  const contentIds = await findBacklogUnevaluatedContents(projectId, limit);
  if (contentIds.length === 0) {
    return [];
  }

  console.log(`[BacklogEvaluator] Found ${contentIds.length} unevaluated matching contents for project ${projectId}. Enqueueing to pg-boss...`);

  for (const contentId of contentIds) {
    try {
      await boss.send('evaluate_content', { contentId, targetProjectId: projectId });
    } catch (err) {
      console.warn(`[BacklogEvaluator] Warning: Could not enqueue to pg-boss:`, err);
    }
  }

  return contentIds;
}
