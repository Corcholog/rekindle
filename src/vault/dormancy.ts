import * as fs from 'fs/promises';

// How long a project's notes have gone untouched: the problem Rekindle exists for.

const DAY_MS = 24 * 60 * 60 * 1000;

/** A project whose notes have not changed for this many days is shown as dormant. */
export const DORMANT_AFTER_DAYS = 14;
// No import of src/config here: it parses the environment on first import, and tests import
// this module before stubbing DATABASE_URL.

/** Newest modification time among the given files; files that vanished meanwhile are skipped. */
export async function newestModification(paths: string[]): Promise<Date | null> {
  let newest = 0;
  for (const file of paths) {
    try {
      newest = Math.max(newest, (await fs.stat(file)).mtimeMs);
    } catch {
      // Deleted between the directory walk and the stat
    }
  }
  return newest > 0 ? new Date(newest) : null;
}

/** Whole days since the notes last changed, or null when unknown. Never negative. */
export function idleDays(notesModifiedAt: Date | null | undefined, now: number = Date.now()): number | null {
  if (!notesModifiedAt) return null;
  return Math.max(0, Math.floor((now - notesModifiedAt.getTime()) / DAY_MS));
}

export function isDormant(days: number | null): boolean {
  return days !== null && days >= DORMANT_AFTER_DAYS;
}
