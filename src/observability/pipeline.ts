import { randomUUID } from 'crypto';
import { db } from '../db';
import { pipelineEvents, pipelineStageEnum } from '../db/schema';
import { ProviderError } from '../ai/types';
import { ChainError } from '../ai/chain';
import { getLogger, sanitizeLogObject } from './logger';

const log = getLogger('pipeline');

export type PipelineStage = (typeof pipelineStageEnum.enumValues)[number];

/** Correlation ID that follows one piece of content from ingestion to its suggestions. */
export function newTraceId(): string {
  return randomUUID();
}

export interface StageEvent {
  traceId: string;
  stage: PipelineStage;
  contentId?: string | null;
  snapshotId?: string | null;
  durationMs?: number | null;
  ok?: boolean;
  errorKind?: string | null;
  /** pg-boss attempt (1 = first run). */
  attempt?: number | null;
  /** IDs, counts, lengths and distances only. Text-like keys are censored as in the logs. */
  attrs?: Record<string, unknown>;
}

/** Short, text-free classification of a failure. */
export function errorKindOf(err: unknown): string {
  if (err instanceof ChainError) return err.quotaExhausted ? 'llm_quota' : err.rateLimited ? 'llm_rate_limit' : 'llm_chain';
  if (err instanceof ProviderError) return err.kind;
  if (err instanceof Error) return err.name === 'Error' ? 'error' : err.name;
  return 'unknown';
}

/** Writes one event and returns its ID; telemetry problems never fail the pipeline. */
export async function recordStage(event: StageEvent): Promise<string | null> {
  try {
    const [row] = await db.insert(pipelineEvents).values({
      traceId: event.traceId,
      stage: event.stage,
      contentId: event.contentId ?? null,
      snapshotId: event.snapshotId ?? null,
      durationMs: event.durationMs ?? null,
      ok: event.ok ?? true,
      errorKind: event.errorKind ?? null,
      attempt: event.attempt ?? null,
      attrs: event.attrs ? sanitizeLogObject(event.attrs) as Record<string, unknown> : null,
    }).returning({ id: pipelineEvents.id });
    return row.id;
  } catch (err) {
    log.warn({ err, stage: event.stage, traceId: event.traceId }, 'Could not record pipeline event');
    return null;
  }
}

/**
 * Runs one stage and records its duration and outcome. A failure is recorded with its error kind
 * and rethrown.
 */
export async function timeStage<T>(
  event: Omit<StageEvent, 'durationMs' | 'ok' | 'errorKind'>,
  fn: () => Promise<T>,
  attrsOf?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    await recordStage({ ...event, durationMs: Date.now() - started, attrs: { ...event.attrs, ...attrsOf?.(result) } });
    return result;
  } catch (err) {
    await recordStage({ ...event, durationMs: Date.now() - started, ok: false, errorKind: errorKindOf(err) });
    throw err;
  }
}
