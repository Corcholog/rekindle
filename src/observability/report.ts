import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db';

// Aggregates over llm_telemetry and pipeline_events for `pnpm telemetry:report`. Rows are one per
// provider attempt, so a call is counted by its first attempt (attempt_no = 1) and a call succeeded
// when one of its attempts did (at most one can).

type Db = typeof defaultDb;

const MALFORMED = ['empty', 'invalid_json', 'schema'];

export interface StageRow {
  stage: string;
  events: number;
  failures: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface ComponentRow {
  component: string;
  calls: number;
  failedCalls: number;
  fallbackCalls: number;
  retries: number;
  p50Ms: number | null;
  p95Ms: number | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ProviderRow {
  provider: string;
  model: string;
  attempts: number;
  ok: number;
  malformed: number;
  rateLimited: number;
  unavailable: number;
  otherErrors: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Attempts that reported tokens but have no price. */
  unpriced: number;
}

export interface TelemetryReport {
  since: Date;
  until: Date;
  stages: StageRow[];
  components: ComponentRow[];
  providers: ProviderRow[];
  totals: {
    calls: number;
    failedCalls: number;
    fallbackCalls: number;
    attempts: number;
    malformedAttempts: number;
    costUsd: number;
    unpricedAttempts: number;
    failedJobs: number;
    jobErrors: { stage: string; errorKind: string; count: number }[];
  };
}

/** "7d", "24h", "30m" or an ISO date. */
export function parseSince(value: string, now = new Date()): Date {
  const match = /^(\d+)([dhm])$/.exec(value.trim());
  if (match) {
    const ms = Number(match[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2] as 'd' | 'h' | 'm'];
    return new Date(now.getTime() - ms);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid period "${value}": use 7d, 24h, 30m or an ISO date`);
  return date;
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const ms = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));

export async function buildReport(options: { since: Date; until?: Date }, db: Db = defaultDb): Promise<TelemetryReport> {
  const since = options.since;
  const until = options.until ?? new Date();
  // timestamp columns hold UTC (drizzle and now() on a UTC session); a Date param would be sent in
  // local time by node-postgres
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const malformed = sql.join(MALFORMED.map(k => sql`${k}`), sql`, `);

  const stages = await db.execute(sql`
    SELECT stage::text AS stage, COUNT(*) AS events, COUNT(*) FILTER (WHERE NOT ok) AS failures,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
    FROM pipeline_events
    WHERE created_at >= ${sinceIso} AND created_at < ${untilIso}
    GROUP BY stage ORDER BY stage`);

  // Latency of a call is the latency of its answering attempt (waits and failed attempts excluded)
  const components = await db.execute(sql`
    SELECT component::text AS component,
      COUNT(*) FILTER (WHERE attempt_no = 1) AS calls,
      COUNT(*) FILTER (WHERE is_success) AS succeeded,
      COUNT(*) FILTER (WHERE is_success AND is_fallback) AS fallback_calls,
      COUNT(*) AS attempts,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE is_success) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE is_success) AS p95,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost
    FROM llm_telemetry
    WHERE created_at >= ${sinceIso} AND created_at < ${untilIso}
    GROUP BY component ORDER BY component`);

  const providers = await db.execute(sql`
    SELECT COALESCE(provider, split_part(model_name, ':', 1)) AS provider,
      substr(model_name, length(COALESCE(provider, split_part(model_name, ':', 1))) + 2) AS model,
      COUNT(*) AS attempts, COUNT(*) FILTER (WHERE is_success) AS ok,
      COUNT(*) FILTER (WHERE error_kind IN (${malformed})) AS malformed,
      COUNT(*) FILTER (WHERE error_kind = 'rate_limit') AS rate_limited,
      COUNT(*) FILTER (WHERE error_kind = 'unavailable') AS unavailable,
      COUNT(*) FILTER (WHERE NOT is_success AND (error_kind IS NULL OR error_kind NOT IN (${malformed}, 'rate_limit', 'unavailable'))) AS other_errors,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost,
      COUNT(*) FILTER (WHERE cost_usd IS NULL AND (prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL)) AS unpriced
    FROM llm_telemetry
    WHERE created_at >= ${sinceIso} AND created_at < ${untilIso}
    GROUP BY 1, 2 ORDER BY 1, 2`);

  const jobErrors = await db.execute(sql`
    SELECT stage::text AS stage, COALESCE(error_kind, 'unknown') AS error_kind, COUNT(*) AS count
    FROM pipeline_events
    WHERE NOT ok AND stage IN ('ingest_job', 'evaluate_job') AND created_at >= ${sinceIso} AND created_at < ${untilIso}
    GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2`);

  const componentRows: ComponentRow[] = components.rows.map((r: any) => ({
    component: r.component,
    calls: n(r.calls),
    failedCalls: n(r.calls) - n(r.succeeded),
    fallbackCalls: n(r.fallback_calls),
    retries: n(r.attempts) - n(r.calls),
    p50Ms: ms(r.p50),
    p95Ms: ms(r.p95),
    promptTokens: n(r.prompt_tokens),
    completionTokens: n(r.completion_tokens),
    costUsd: n(r.cost),
  }));
  const providerRows: ProviderRow[] = providers.rows.map((r: any) => ({
    provider: r.provider,
    model: r.model,
    attempts: n(r.attempts),
    ok: n(r.ok),
    malformed: n(r.malformed),
    rateLimited: n(r.rate_limited),
    unavailable: n(r.unavailable),
    otherErrors: n(r.other_errors),
    promptTokens: n(r.prompt_tokens),
    completionTokens: n(r.completion_tokens),
    costUsd: n(r.cost),
    unpriced: n(r.unpriced),
  }));
  const jobErrorRows = jobErrors.rows.map((r: any) => ({ stage: r.stage, errorKind: r.error_kind, count: n(r.count) }));
  const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((acc, r) => acc + f(r), 0);

  return {
    since,
    until,
    stages: stages.rows.map((r: any) => ({ stage: r.stage, events: n(r.events), failures: n(r.failures), p50Ms: ms(r.p50), p95Ms: ms(r.p95) })),
    components: componentRows,
    providers: providerRows,
    totals: {
      calls: sum(componentRows, r => r.calls),
      failedCalls: sum(componentRows, r => r.failedCalls),
      fallbackCalls: sum(componentRows, r => r.fallbackCalls),
      attempts: sum(providerRows, r => r.attempts),
      malformedAttempts: sum(providerRows, r => r.malformed),
      costUsd: sum(providerRows, r => r.costUsd),
      unpricedAttempts: sum(providerRows, r => r.unpriced),
      failedJobs: sum(jobErrorRows, r => r.count),
      jobErrors: jobErrorRows,
    },
  };
}

const pct = (part: number, whole: number) => (whole === 0 ? '–' : `${((part / whole) * 100).toFixed(1)}%`);
const dur = (v: number | null) => (v === null ? '–' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const usd = (v: number) => `$${v.toFixed(4)}`;

function table(header: string[], rows: string[][]): string[] {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)];
}

export function renderReport(r: TelemetryReport): string {
  const t = r.totals;
  const out: string[] = [
    `# Loom telemetry, ${r.since.toISOString()} to ${r.until.toISOString()}`,
    '',
    `LLM calls: ${t.calls} · failure rate ${pct(t.failedCalls, t.calls)} · fallback rate ${pct(t.fallbackCalls, t.calls - t.failedCalls)} · malformed attempts ${pct(t.malformedAttempts, t.attempts)} · estimated cost ${usd(t.costUsd)}${t.unpricedAttempts > 0 ? ` (+ ${t.unpricedAttempts} attempts not priced)` : ''}`,
    `Failed queue jobs: ${t.failedJobs}`,
    '',
    '## Pipeline stages',
    '',
  ];
  if (r.stages.length === 0) out.push('No pipeline events in this period.');
  else out.push(...table(['Stage', 'Events', 'Failures', 'p50', 'p95'],
    r.stages.map(s => [s.stage, String(s.events), `${s.failures} (${pct(s.failures, s.events)})`, dur(s.p50Ms), dur(s.p95Ms)])));

  out.push('', '## LLM calls by component', '');
  if (r.components.length === 0) out.push('No LLM calls in this period.');
  else out.push(...table(['Component', 'Calls', 'Failed', 'Fallback', 'Retries', 'p50', 'p95', 'Tokens in / out', 'Cost'],
    r.components.map(c => [c.component, String(c.calls), `${c.failedCalls} (${pct(c.failedCalls, c.calls)})`,
      `${c.fallbackCalls} (${pct(c.fallbackCalls, c.calls - c.failedCalls)})`, String(c.retries), dur(c.p50Ms), dur(c.p95Ms),
      `${c.promptTokens} / ${c.completionTokens}`, usd(c.costUsd)])));

  out.push('', '## Attempts by provider', '');
  if (r.providers.length === 0) out.push('No attempts in this period.');
  else out.push(...table(['Provider', 'Model', 'Attempts', 'OK', 'Malformed', 'Rate limited', 'Unavailable', 'Other errors', 'Tokens in / out', 'Cost'],
    r.providers.map(p => [p.provider, p.model, String(p.attempts), String(p.ok), String(p.malformed), String(p.rateLimited),
      String(p.unavailable), String(p.otherErrors), `${p.promptTokens} / ${p.completionTokens}`,
      p.unpriced > 0 && p.costUsd === 0 ? 'not priced' : `${usd(p.costUsd)}${p.unpriced > 0 ? ` + ${p.unpriced} not priced` : ''}`])));

  if (t.jobErrors.length > 0) {
    out.push('', '## Failed jobs by error kind', '', ...table(['Job', 'Error kind', 'Count'], t.jobErrors.map(e => [e.stage, e.errorKind, String(e.count)])));
  }
  out.push('', 'Cost is an estimate from list prices in src/ai/pricing.ts (DeepSeek at its peak rate, an upper bound). Latency is the answering attempt; p50/p95 interpolate (percentile_cont).');
  return out.join('\n');
}

/** Deletes telemetry and pipeline events older than the cutoff. Evaluations keep their rows. */
export async function pruneTelemetry(olderThan: Date, db: Db = defaultDb): Promise<{ llmTelemetry: number; pipelineEvents: number }> {
  return db.transaction(async (tx) => {
    const telemetry = await tx.execute(sql`DELETE FROM llm_telemetry WHERE created_at < ${olderThan.toISOString()}`);
    const events = await tx.execute(sql`DELETE FROM pipeline_events WHERE created_at < ${olderThan.toISOString()}`);
    return { llmTelemetry: telemetry.rowCount ?? 0, pipelineEvents: events.rowCount ?? 0 };
  });
}
