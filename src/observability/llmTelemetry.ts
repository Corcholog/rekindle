import { createHash } from 'crypto';
import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { llmTelemetry, telemetryComponentEnum } from '../db/schema';
import type { Attempt } from '../ai/types';
import { attemptCostUsd } from '../ai/pricing';
import { getLogger } from './logger';

const log = getLogger('telemetry');

export type TelemetryComponent = (typeof telemetryComponentEnum.enumValues)[number];

/** What an LLM call is for, so its telemetry rows can be joined to the pipeline. */
export interface LlmCallContext {
  component: TelemetryComponent;
  traceId?: string | null;
  contentId?: string | null;
  snapshotId?: string | null;
  suggestionId?: string | null;
}

/** Identifies a prompt without storing it: equal prompts share a hash. */
export function promptHash(system: string, user: string): string {
  return createHash('sha256').update(system).update('\0').update(user).digest('hex').slice(0, 16);
}

export type TelemetryRow = typeof llmTelemetry.$inferInsert;

/**
 * One row per provider attempt. Only lengths, token counts and a hash describe the prompt and the
 * answer; their text is never stored.
 */
export function telemetryRows(ctx: LlmCallContext, system: string, user: string, attempts: Attempt[], data?: unknown): TelemetryRow[] {
  const hash = promptHash(system, user);
  const promptChars = system.length + user.length;
  const firstProvider = attempts[0]?.provider;
  return attempts.map((attempt, i) => ({
    component: ctx.component,
    traceId: ctx.traceId ?? null,
    contentId: ctx.contentId ?? null,
    snapshotId: ctx.snapshotId ?? null,
    suggestionId: ctx.suggestionId ?? null,
    modelName: `${attempt.provider}:${attempt.model}`,
    provider: attempt.provider,
    attemptNo: i + 1,
    isSuccess: attempt.ok,
    errorKind: attempt.errorKind ?? null,
    isFallback: attempt.provider !== firstProvider,
    waitedMs: attempt.waitedMs ?? null,
    latencyMs: attempt.latencyMs,
    promptTokens: attempt.usage?.promptTokens ?? null,
    completionTokens: attempt.usage?.completionTokens ?? null,
    costUsd: attemptCostUsd(attempt.provider, attempt.model, attempt.usage),
    promptChars,
    completionChars: attempt.ok && data !== undefined ? JSON.stringify(data).length : null,
    promptHash: hash,
  }));
}

/** Writes the rows; telemetry problems are logged and never fail the call being recorded. */
export async function recordLlmCall(ctx: LlmCallContext, system: string, user: string, attempts: Attempt[], data?: unknown): Promise<string[]> {
  const rows = telemetryRows(ctx, system, user, attempts, data);
  if (rows.length === 0) return [];
  try {
    const inserted = await db.insert(llmTelemetry).values(rows).returning({ id: llmTelemetry.id });
    return inserted.map(r => r.id);
  } catch (err) {
    log.warn({ err, component: ctx.component, rows: rows.length }, 'Could not record LLM telemetry');
    return [];
  }
}

/** Links telemetry rows to the suggestion they produced (known only after the call). */
export async function linkTelemetryToSuggestion(telemetryIds: string[], suggestionId: string): Promise<void> {
  if (telemetryIds.length === 0) return;
  try {
    await db.update(llmTelemetry).set({ suggestionId }).where(inArray(llmTelemetry.id, telemetryIds));
  } catch (err) {
    log.warn({ err, suggestionId }, 'Could not link LLM telemetry to its suggestion');
  }
}
