import { asc, eq } from 'drizzle-orm';
import { db as defaultDb } from '../db';
import { actionSuggestions, contents, evaluations, llmTelemetry, pipelineEvents } from '../db/schema';

// `pnpm telemetry:trace <suggestionId|contentId>`: follows a suggestion back to its content and the
// retrieval step that selected the project, with every stage and LLM attempt of its traces.
// Shows IDs, numbers and enums only; no note, article or prompt text.

type Db = typeof defaultDb;

export interface TraceView {
  contentId: string;
  ingestStatus: string;
  suggestion: { id: string; status: string; actionType: string; projectId: string; evaluationId: string } | null;
  evaluation: { id: string; verdict: string | null; confidence: number | null; snapshotId: string; traceId: string | null; retrievalEventId: string | null } | null;
  /** The ingestion trace first, then the evaluation's trace when it differs (backlog, re-evaluation). */
  traces: Array<{
    traceId: string;
    events: Array<typeof pipelineEvents.$inferSelect>;
    llm: Array<Pick<typeof llmTelemetry.$inferSelect, 'component' | 'provider' | 'modelName' | 'attemptNo' | 'isSuccess' | 'errorKind' | 'isFallback' | 'latencyMs' | 'waitedMs' | 'promptTokens' | 'completionTokens' | 'costUsd' | 'promptChars' | 'completionChars' | 'promptHash' | 'snapshotId' | 'suggestionId' | 'createdAt'>>;
  }>;
}

export async function buildTrace(id: string, db: Db = defaultDb): Promise<TraceView | null> {
  const [suggestion] = await db.select().from(actionSuggestions).where(eq(actionSuggestions.id, id)).limit(1);
  const contentId = suggestion?.contentId ?? id;
  const [content] = await db.select({ id: contents.id, traceId: contents.traceId, ingestStatus: contents.ingestStatus })
    .from(contents).where(eq(contents.id, contentId)).limit(1);
  if (!content) return null;

  const [evaluation] = suggestion
    ? await db.select().from(evaluations).where(eq(evaluations.id, suggestion.evaluationId)).limit(1)
    : [];

  const traceIds = [...new Set([content.traceId, evaluation?.traceId].filter((t): t is string => Boolean(t)))];
  // A content without a stored trace (ingested before Phase 4) may still have evaluation traces
  if (!suggestion) {
    const evals = await db.select({ traceId: evaluations.traceId }).from(evaluations).where(eq(evaluations.contentId, contentId));
    for (const e of evals) if (e.traceId && !traceIds.includes(e.traceId)) traceIds.push(e.traceId);
  }

  const traces: TraceView['traces'] = [];
  for (const traceId of traceIds) {
    const events = await db.select().from(pipelineEvents).where(eq(pipelineEvents.traceId, traceId)).orderBy(asc(pipelineEvents.createdAt));
    const llm = await db.select({
      component: llmTelemetry.component, provider: llmTelemetry.provider, modelName: llmTelemetry.modelName,
      attemptNo: llmTelemetry.attemptNo, isSuccess: llmTelemetry.isSuccess, errorKind: llmTelemetry.errorKind,
      isFallback: llmTelemetry.isFallback, latencyMs: llmTelemetry.latencyMs, waitedMs: llmTelemetry.waitedMs,
      promptTokens: llmTelemetry.promptTokens, completionTokens: llmTelemetry.completionTokens, costUsd: llmTelemetry.costUsd,
      promptChars: llmTelemetry.promptChars, completionChars: llmTelemetry.completionChars, promptHash: llmTelemetry.promptHash,
      snapshotId: llmTelemetry.snapshotId, suggestionId: llmTelemetry.suggestionId, createdAt: llmTelemetry.createdAt,
    }).from(llmTelemetry).where(eq(llmTelemetry.traceId, traceId)).orderBy(asc(llmTelemetry.createdAt), asc(llmTelemetry.attemptNo));
    traces.push({ traceId, events, llm });
  }

  return {
    contentId,
    ingestStatus: content.ingestStatus,
    suggestion: suggestion ? {
      id: suggestion.id, status: suggestion.status, actionType: suggestion.actionType, projectId: suggestion.projectId, evaluationId: suggestion.evaluationId,
    } : null,
    evaluation: evaluation ? {
      id: evaluation.id, verdict: evaluation.verdict, confidence: evaluation.confidenceScore, snapshotId: evaluation.projectSnapshotId,
      traceId: evaluation.traceId, retrievalEventId: evaluation.retrievalEventId,
    } : null,
    traces,
  };
}

export function renderTrace(view: TraceView): string {
  const out: string[] = [`# Trace for content ${view.contentId} (ingest status: ${view.ingestStatus})`, ''];
  if (view.suggestion) {
    const s = view.suggestion;
    out.push(`Suggestion ${s.id}: ${s.actionType}, ${s.status}, project ${s.projectId}`);
  }
  if (view.evaluation) {
    const e = view.evaluation;
    out.push(`Evaluation ${e.id}: ${e.verdict ?? '–'}${e.confidence !== null ? ` (${Math.round(e.confidence * 100)}%)` : ''}, snapshot ${e.snapshotId}`);
    out.push(`Selected by retrieval event: ${e.retrievalEventId ?? 'not recorded (evaluated before Phase 4, re-evaluated, or the event was pruned)'}`);
  }
  if (view.traces.length === 0) out.push('', 'No trace recorded for this content (ingested before Phase 4).');

  for (const trace of view.traces) {
    out.push('', `## Trace ${trace.traceId}`, '');
    for (const e of trace.events) {
      const status = e.ok ? 'ok' : `FAILED (${e.errorKind ?? 'unknown'})`;
      const marker = view.evaluation?.retrievalEventId === e.id ? '  <- selected this suggestion' : '';
      out.push(`- ${e.createdAt.toISOString()} ${e.stage.padEnd(12)} ${status}${e.durationMs !== null ? `, ${e.durationMs} ms` : ''}${e.attempt ? `, attempt ${e.attempt}` : ''}${e.snapshotId ? `, snapshot ${e.snapshotId}` : ''}${marker}`);
      const attrs = (e.attrs ?? {}) as Record<string, unknown>;
      if (e.stage === 'retrieve') {
        out.push(`    threshold ${attrs.threshold}, limit ${attrs.limit}, within threshold ${attrs.withinThreshold}, returned ${attrs.returned}`);
        for (const c of (attrs.candidates as any[] | undefined) ?? []) {
          const chosen = view.evaluation?.snapshotId === c.snapshotId ? '  *' : '';
          out.push(`    #${c.rank} project ${c.projectId} ${c.level} distance ${c.distance}${c.noteSnapshotId ? ` note ${c.noteSnapshotId}` : ''}${chosen}`);
        }
      } else {
        const rest = Object.entries(attrs).filter(([k]) => k !== 'candidates').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
        if (rest.length > 0) out.push(`    ${rest.join(' ')}`);
      }
    }
    if (trace.llm.length > 0) {
      out.push('', 'LLM attempts:');
      for (const a of trace.llm) {
        out.push(`- ${a.component} #${a.attemptNo ?? '?'} ${a.modelName} ${a.isSuccess ? 'ok' : `failed (${a.errorKind ?? 'unknown'})`}${a.isFallback ? ' [fallback]' : ''}, ${a.latencyMs ?? '–'} ms${a.waitedMs ? ` (+${a.waitedMs} ms wait)` : ''}, tokens ${a.promptTokens ?? '–'}/${a.completionTokens ?? '–'}, cost ${a.costUsd === null ? 'not priced' : `$${a.costUsd.toFixed(5)}`}, prompt ${a.promptChars ?? '–'} chars #${a.promptHash ?? '–'}`);
      }
    }
  }
  return out.join('\n');
}
