/**
 * The note an LLM suggestion points at (audit F-13). The model names a note from the prompt's index
 * by path or by title, or proposes a new note when none fits. Everything is checked here, never
 * trusted to the model: an existing note must be one of the project's notes, and a new note must be
 * a plain relative name inside the project, at its root or in a folder that already holds notes.
 * Anything else is replaced by the closest note found by retrieval, or "unknown" (no note) when the
 * project matched as a whole. Accepted callouts are always written to <project>/suggestions.md; this
 * value is what the UI shows, what the callout links to, and what staleness detection compares.
 */

export interface ProjectNoteRef {
  /** Relative to the project folder. */
  path: string;
  title: string;
}

export interface ResolvedTarget {
  path: string;
  /** The note does not exist: the model proposes creating it. */
  isNew: boolean;
}

/** Placeholder target when there is no note to point at; the UI and the callout show no note. */
export const NO_NOTE = 'unknown';

const MAX_NEW_NOTE_LENGTH = 120;
// Characters that break Obsidian links or file names
const UNSAFE_NAME = /[[\]|#^:*?"<>\\]/;
const hasControlCharacter = (name: string) => [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

// Accented names can reach Rekindle in either Unicode form (macOS file systems often give the
// decomposed one, a model writes the composed one), so names are compared in NFC, case-insensitively,
// and the note's own stored path is returned (F-28)
const key = (value: string) => value.normalize('NFC').toLowerCase();

function existingNote(name: string, notes: readonly ProjectNoteRef[]): string | null {
  const paths = notes.map(n => n.path);
  const withMd = name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
  for (const candidate of [name, withMd]) {
    if (paths.includes(candidate)) return candidate;
  }
  const lower = key(withMd);
  const byPath = paths.filter(p => key(p) === lower);
  if (byPath.length === 1) return byPath[0];
  // A bare file name ("mechanics.md") names the note only if exactly one note has it
  const bySuffix = paths.filter(p => key(p).endsWith(`/${lower}`));
  if (bySuffix.length === 1) return bySuffix[0];
  // The index shows titles too, and models often answer with one
  const title = key(name.replace(/\.md$/i, '').trim());
  const byTitle = notes.filter(n => key(n.title.trim()) === title);
  return byTitle.length === 1 ? byTitle[0].path : null;
}

function newNotePath(name: string, notes: readonly ProjectNoteRef[]): string | null {
  if (name.length > MAX_NEW_NOTE_LENGTH || UNSAFE_NAME.test(name) || hasControlCharacter(name) || name.startsWith('/')) return null;
  const segments = name.split('/');
  if (segments.some(s => !s.trim() || s.startsWith('.') || s !== s.trim())) return null;
  const withMd = name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
  const folder = withMd.includes('/') ? withMd.slice(0, withMd.lastIndexOf('/')) : '';
  if (folder && !notes.some(n => key(n.path).startsWith(`${key(folder)}/`))) return null;
  return withMd;
}

export function resolveTarget(
  proposed: string | null | undefined,
  proposedIsNew: boolean | null | undefined,
  notes: readonly ProjectNoteRef[],
  fallback: string | null,
): ResolvedTarget {
  const fallbackTarget = { path: fallback || NO_NOTE, isNew: false };
  const cleaned = (proposed ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned || cleaned.split('/').includes('..')) return fallbackTarget;

  const existing = existingNote(cleaned, notes);
  if (existing) return { path: existing, isNew: false };
  if (!proposedIsNew) return fallbackTarget;

  const created = newNotePath(cleaned, notes);
  return created ? { path: created, isNew: true } : fallbackTarget;
}
