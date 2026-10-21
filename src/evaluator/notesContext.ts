import { Language } from '../ai/language';

export interface ContextNote {
  /** Path relative to the project folder, as stored in the note snapshot. */
  path: string;
  title: string;
  text: string;
  /** Distance to the article; only needed when the notes do not fit the budget. */
  distance?: number | null;
}

export interface NotesContext {
  text: string;
  /** Notes whose text went in, whole or cut. */
  included: number;
  /** Notes listed in the index only. */
  omitted: number;
}

/** Characters of note text the notes would take, the figure compared with the budget. */
export function notesTextChars(notes: readonly ContextNote[]): number {
  return notes.reduce((sum, n) => sum + n.text.length, 0);
}

/** Below this, a cut piece of a note is not worth sending. */
const MIN_PIECE = 1000;

/**
 * The project's notes for a prompt: an index of every note's path, so the model can point at any of
 * them, and the notes' text within `budgetChars`. When everything fits, every note goes in whole in
 * path order, so the block is the same for every article and providers can cache it. Otherwise the
 * notes closest to the article go first; notes left out stay in the index, marked as such.
 */
export function buildNotesContext(notes: readonly ContextNote[], budgetChars: number, lang: Language): NotesContext {
  const en = lang === 'en';
  const byPath = [...notes].sort((a, b) => a.path.localeCompare(b.path));
  const fits = notesTextChars(notes) <= budgetChars;
  const order = fits
    ? byPath
    : [...notes].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.path.localeCompare(b.path));

  const bodies: { note: ContextNote; text: string }[] = [];
  let left = budgetChars;
  for (const note of order) {
    if (!note.text) continue;
    if (note.text.length <= left) {
      bodies.push({ note, text: note.text });
      left -= note.text.length;
    } else if (left >= MIN_PIECE) {
      bodies.push({ note, text: `${note.text.substring(0, left)} […]` });
      left = 0;
    }
  }

  const sent = new Set(bodies.map(b => b.note.path));
  const label = (n: ContextNote) => `${n.path} — "${n.title}"`;
  const notSent = en ? ' (text not included)' : ' (texto no incluido)';
  const index = byPath.map(n => `- ${label(n)}${n.text && !sent.has(n.path) ? notSent : ''}`).join('\n');
  const indexHeading = en ? 'NOTE INDEX (paths relative to the project):' : 'ÍNDICE DE NOTAS (rutas relativas al proyecto):';
  const body = bodies.map(b => `### ${label(b.note)}\n${b.text}`).join('\n\n');

  return {
    text: body ? `${indexHeading}\n${index}\n\n${body}` : `${indexHeading}\n${index}`,
    included: bodies.length,
    omitted: notes.filter(n => n.text && !sent.has(n.path)).length,
  };
}
