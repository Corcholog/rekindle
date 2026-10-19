import type { Project } from './api';

// Mirrors src/vault/dormancy.ts: a project untouched for this many days is dormant.
export const DORMANT_AFTER_DAYS = 14;

export type Heat = 'burning' | 'embers' | 'ash';

/**
 * A project is a fire: burning while worked on this week, embers after a week, ash once dormant.
 * Unknown idle time (never read) shows as ash, without a claim about heat.
 */
export function heatOf(idleDays: number | null | undefined): Heat {
  if (idleDays === null || idleDays === undefined) return 'ash';
  if (idleDays < 7) return 'burning';
  return idleDays < DORMANT_AFTER_DAYS ? 'embers' : 'ash';
}

export const activeCount = (p: Pick<Project, 'counts'>) => p.counts.active ?? p.counts.pending + (p.counts.tentative ?? 0);

/** Dormant projects with something to review come first: they are what Rekindle is for. */
export function sortProjects<T extends Pick<Project, 'counts' | 'isDormant' | 'idleDays' | 'title'>>(projects: T[]): T[] {
  return [...projects].sort((a, b) =>
    Number(b.isDormant && activeCount(b) > 0) - Number(a.isDormant && activeCount(a) > 0)
    || activeCount(b) - activeCount(a)
    || (b.idleDays ?? -1) - (a.idleDays ?? -1)
    || a.title.localeCompare(b.title));
}

/** A suggestion "rekindles" its project when the project had been dormant at evaluation time. */
export const rekindles = (projectIdleDays: number | null | undefined) => (projectIdleDays ?? 0) >= DORMANT_AFTER_DAYS;
