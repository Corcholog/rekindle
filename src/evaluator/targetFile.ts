/**
 * The note an LLM suggestion points at must be one of the project's notes (audit F-13). Model text
 * such as "../../Personal/diario.md" or "research/%" is replaced by the closest note found by
 * retrieval, or ideas.md. Accepted callouts are always written to <project>/suggestions.md; this
 * value is what the UI shows and what staleness detection compares.
 */
export function resolveTargetFile(proposed: string | null | undefined, notePaths: readonly string[], fallback: string | null): string {
  const fallbackPath = fallback || 'ideas.md';
  if (!proposed) return fallbackPath;
  const cleaned = proposed.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned || cleaned.split('/').includes('..')) return fallbackPath;

  const withMd = cleaned.toLowerCase().endsWith('.md') ? cleaned : `${cleaned}.md`;
  for (const candidate of [cleaned, withMd]) {
    if (notePaths.includes(candidate)) return candidate;
  }
  // A bare file name ("mechanics.md") names the note only if exactly one note has it
  const bySuffix = notePaths.filter(p => p.endsWith(`/${withMd}`));
  return bySuffix.length === 1 ? bySuffix[0] : fallbackPath;
}
