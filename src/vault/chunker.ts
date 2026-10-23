import { createHash } from 'crypto';

/**
 * Document-based chunking for long notes: a note is split where its own structure splits it, at
 * Markdown headings first, then at paragraphs, and only a section longer than CHUNK_CHARS is cut,
 * with CHUNK_OVERLAP characters carried into the next piece. Each piece keeps its heading path
 * ("Acto 2 › La saturación"), so retrieval can say which section of a note an article is close to.
 * Notes up to EMBED_NOTE_CHARS are not chunked: their single embedding already covers them.
 */

export const CHUNK_CHARS = 1500;
export const CHUNK_OVERLAP = 200;
/** A guard for pathological notes; 200,000 characters (MAX_NOTE_CHARS) make about 140 pieces. */
export const MAX_CHUNKS_PER_NOTE = 200;
/** A heading path is a label in prompts and the UI, not content. */
export const MAX_HEADING_CHARS = 200;

export interface NoteChunk {
  index: number;
  /** Heading path of the section the piece belongs to, outermost first; null before the first heading. */
  heading: string | null;
  text: string;
  /** sha256 of the embedding input, so an unchanged piece reuses its embedding. */
  hash: string;
}

interface Section { heading: string | null; text: string }

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function sections(markdown: string): Section[] {
  const out: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join('\n').trim();
    if (text) out.push({ heading: stack.length ? stack.map(h => h.title).join(' › ').substring(0, MAX_HEADING_CHARS) : null, text });
    lines = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (!match) { lines.push(line); continue; }
    flush();
    const level = match[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: match[2].trim() });
  }
  flush();
  return out;
}

/** Splits text longer than `max` at paragraphs, then sentences, then words, with `overlap` carried over. */
function split(text: string, max: number, overlap: number): string[] {
  if (text.length <= max) return [text];
  // Text cut inside a paragraph leaves room for the carried overlap, so the cut is always bridged
  const cutAt = max - overlap - 2;
  const units = text.split(/\n\s*\n/).flatMap(p => (p.length <= max ? [p] : p.split(/(?<=[.!?…])\s+/)))
    .flatMap(s => (s.length <= max ? [s] : s.match(new RegExp(`[\\s\\S]{1,${cutAt}}(?=\\s|$)|[\\s\\S]{1,${cutAt}}`, 'g')) ?? [s]));
  const pieces: string[] = [];
  let current = '';
  for (const unit of units) {
    const joined = current ? `${current}\n\n${unit}` : unit;
    if (joined.length <= max || !current) { current = joined; continue; }
    pieces.push(current);
    // The tail of the previous piece, from a word boundary, so a sentence cut by the split is in both
    const tail = current.slice(-overlap);
    const carry = tail.slice(Math.max(0, tail.search(/\s/) + 1)).trim();
    current = carry && carry.length + unit.length + 2 <= max ? `${carry}\n\n${unit}` : unit;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** The text a piece is embedded with: the note's title and the section's heading path give it context. */
export function chunkEmbeddingInput(noteTitle: string, chunk: Pick<NoteChunk, 'heading' | 'text'>): string {
  return `Nota: ${noteTitle}${chunk.heading ? `\nSección: ${chunk.heading}` : ''}\n\n${chunk.text}`;
}

/** The pieces of a note, or none when its text fits a single embedding (`minChars`). */
export function chunkNote(noteTitle: string, markdown: string, minChars: number): NoteChunk[] {
  const body = markdown.trim();
  if (body.length <= minChars) return [];
  const chunks: NoteChunk[] = [];
  for (const section of sections(body)) {
    for (const text of split(section.text, CHUNK_CHARS, CHUNK_OVERLAP)) {
      if (chunks.length === MAX_CHUNKS_PER_NOTE) return chunks;
      const piece = { heading: section.heading, text };
      chunks.push({ index: chunks.length, ...piece, hash: createHash('sha256').update(chunkEmbeddingInput(noteTitle, piece)).digest('hex') });
    }
  }
  return chunks;
}
