import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db';
import { DISCARD_REASONS } from '../db/schema';

// Counts for `pnpm usertest:stats`, run by a tester on their own machine after a session. It
// reads only enum values, counts and durations: never article text, notes, titles or URLs, so
// the output can be pasted into the session sheet.
//
// Durations use only columns filled by the database clock (consumed_at, created_at). resolved_at
// is written by Node, and the two clocks are not comparable on a machine outside UTC, so the time
// to the first accepted suggestion is taken with a stopwatch instead (docs/USER_TEST.md).

type Db = typeof defaultDb;

export interface UserTestStats {
  articlesReady: number;
  articlesFailed: number;
  suggestions: { total: number; pending: number; accepted: number; discarded: number };
  /** accepted / (accepted + discarded); null until something is resolved. */
  acceptanceRate: number | null;
  discardReasons: Record<string, number>;
  /** Discards that gave no reason. */
  discardsWithoutReason: number;
  /** Seconds from the first clipped article to the first suggestion created. */
  secondsToFirstSuggestion: number | null;
}

const num = (value: unknown) => Number(value ?? 0);

export async function buildUserTestStats(db: Db = defaultDb): Promise<UserTestStats> {
  const articles = await db.execute(sql`
    SELECT count(*) FILTER (WHERE ingest_status = 'ready') AS ready,
           count(*) FILTER (WHERE ingest_status = 'failed') AS failed
    FROM contents`);
  const counts = await db.execute(sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE status = 'pending') AS pending,
           count(*) FILTER (WHERE status = 'accepted') AS accepted,
           count(*) FILTER (WHERE status = 'discarded') AS discarded
    FROM action_suggestions`);
  const reasons = await db.execute(sql`
    SELECT discard_reason AS reason, count(*) AS n
    FROM action_suggestions WHERE status = 'discarded' AND discard_reason IS NOT NULL GROUP BY discard_reason`);
  const timing = await db.execute(sql`
    SELECT EXTRACT(EPOCH FROM (
      (SELECT min(created_at) FROM action_suggestions) - (SELECT min(consumed_at) FROM contents)
    )) AS seconds`);

  const c = counts.rows[0] as Record<string, unknown>;
  const accepted = num(c.accepted);
  const discarded = num(c.discarded);
  const discardReasons: Record<string, number> = Object.fromEntries(DISCARD_REASONS.map(r => [r, 0]));
  let withReason = 0;
  for (const row of reasons.rows as { reason: string; n: unknown }[]) {
    discardReasons[row.reason] = num(row.n);
    withReason += num(row.n);
  }
  const seconds = (timing.rows[0] as { seconds: unknown }).seconds;

  return {
    articlesReady: num((articles.rows[0] as Record<string, unknown>).ready),
    articlesFailed: num((articles.rows[0] as Record<string, unknown>).failed),
    suggestions: {
      total: num(c.total), pending: num(c.pending), accepted, discarded,
    },
    acceptanceRate: accepted + discarded > 0 ? accepted / (accepted + discarded) : null,
    discardReasons,
    discardsWithoutReason: discarded - withReason,
    secondsToFirstSuggestion: seconds === null || seconds === undefined ? null : Math.max(0, Math.round(Number(seconds))),
  };
}

const REASON_LABELS: Record<string, string> = {
  unrelated: 'unrelated', obvious: 'already known / obvious', wrong_note: 'wrong note', poorly_worded: 'poorly worded', other: 'other',
};

export function renderUserTestStats(s: UserTestStats): string {
  const pct = (value: number | null) => (value === null ? 'not measured (nothing resolved yet)' : `${(value * 100).toFixed(0)}%`);
  const lines = [
    'Rekindle user-test counts (no text, titles or URLs)',
    '',
    `Articles: ${s.articlesReady} ready, ${s.articlesFailed} failed`,
    `Suggestions: ${s.suggestions.total} (${s.suggestions.accepted} accepted, ${s.suggestions.discarded} discarded, ${s.suggestions.pending} pending)`,
    `Acceptance rate (accepted / resolved): ${pct(s.acceptanceRate)}`,
    `Time from first article to first suggestion: ${s.secondsToFirstSuggestion === null ? 'not measured (no suggestion yet)' : `${s.secondsToFirstSuggestion} s`}`,
    '',
    'Discard reasons:',
    ...Object.entries(s.discardReasons).map(([reason, n]) => `  ${REASON_LABELS[reason] ?? reason}: ${n}`),
    `  no reason given: ${s.discardsWithoutReason}`,
  ];
  return lines.join('\n');
}
