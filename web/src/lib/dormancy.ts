import type { Project } from './api';

// Mirrors src/vault/dormancy.ts: a project untouched for this many days is dormant.
export const DORMANT_AFTER_DAYS = 14;

/** Ash when recently worked on, warm after a week, hot (glowing) once dormant. */
export function heatOf(idleDays: number | null | undefined): 'ash' | 'warm' | 'hot' {
  if (idleDays === null || idleDays === undefined || idleDays < 7) return 'ash';
  return idleDays < DORMANT_AFTER_DAYS ? 'warm' : 'hot';
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
