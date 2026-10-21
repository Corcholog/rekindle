import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { projects, projectSnapshots, projectNoteSnapshots } from '../db/schema';
import { VECTOR_DISTANCE_THRESHOLD, TOP_K_PROJECTS_LIMIT, NOTES_CONTEXT_CHARS, env } from '../config';
import { Language } from '../ai/language';
import { buildNotesContext, ContextNote, NotesContext, notesTextChars } from './notesContext';

export interface RetrievalCandidate {
  snapshotId: string;
  projectId: string;
  thesisText: string;
  notesContent: string;
  /** Best-matching note of the project, when a note is closer than the threshold. */
  noteSnapshotId: string | null;
  notePath: string | null;
  noteTitle: string | null;
  noteSnippet: string | null;
  /** Cosine distance of the best match: the note's if one matched, otherwise the project's. */
  distance: number;
  level: 'note' | 'project';
}

export interface RetrievalOptions {
  targetProjectId?: string;
  threshold?: number;
  limit?: number;
  embedModel?: string;
}

export interface RetrievalResult {
  candidates: RetrievalCandidate[];
  /** Projects within the threshold before the limit was applied. */
  withinThreshold: number;
  threshold: number;
  limit: number;
}

/**
 * Step 1 of the evaluation: active projects whose latest snapshot, or one of its notes, lies
 * within `threshold` of the content embedding. Only embeddings from `embedModel` are compared
 * (invariant I7). Returns one candidate per project, closest first.
 */
export async function retrieveCandidates(
  contentEmbedding: number[],
  options: RetrievalOptions = {},
): Promise<RetrievalCandidate[]> {
  return (await retrieveWithStats(contentEmbedding, options)).candidates;
}

/** retrieveCandidates plus what the limit cut, for the pipeline telemetry. */
export async function retrieveWithStats(
  contentEmbedding: number[],
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const threshold = options.threshold ?? VECTOR_DISTANCE_THRESHOLD;
  const limit = options.limit ?? TOP_K_PROJECTS_LIMIT;
  const embedModel = options.embedModel ?? env.EMBED_MODEL;
  const targetVector = `[${contentEmbedding.join(',')}]`;
  const projectFilter = options.targetProjectId ? sql`AND p.id = ${options.targetProjectId}` : sql``;

  const result = await db.execute(sql`
    WITH latest_snapshots AS (
      SELECT DISTINCT ON (project_id) id, project_id, thesis_text, notes_content, embedding, embedding_model, captured_at
      FROM ${projectSnapshots}
      ORDER BY project_id, captured_at DESC
    ),
    matching_notes AS (
      SELECT DISTINCT ON (pns.project_id)
        pns.project_id,
        pns.id AS note_snapshot_id,
        pns.note_path,
        pns.note_title,
        pns.content_snippet,
        (pns.embedding <=> ${targetVector}::vector) AS note_distance
      FROM ${projectNoteSnapshots} pns
      JOIN latest_snapshots ls ON pns.project_snapshot_id = ls.id
      WHERE pns.embedding IS NOT NULL
        AND pns.embedding_model = ${embedModel}
        AND (pns.embedding <=> ${targetVector}::vector) < ${threshold}
      ORDER BY pns.project_id, (pns.embedding <=> ${targetVector}::vector) ASC
    )
    SELECT
      ls.id AS snapshot_id,
      ls.project_id,
      ls.thesis_text,
      ls.notes_content,
      mn.note_snapshot_id AS matched_note_snapshot_id,
      mn.note_path AS matched_note_path,
      mn.note_title AS matched_note_title,
      mn.content_snippet AS matched_note_snippet,
      COALESCE(mn.note_distance, (ls.embedding <=> ${targetVector}::vector)) AS best_distance,
      COUNT(*) OVER () AS within_threshold
    FROM latest_snapshots ls
    JOIN ${projects} p ON ls.project_id = p.id
    LEFT JOIN matching_notes mn ON ls.project_id = mn.project_id
    WHERE p.is_active = true
      ${projectFilter}
      AND (
        mn.note_path IS NOT NULL
        OR (ls.embedding IS NOT NULL AND ls.embedding_model = ${embedModel} AND (ls.embedding <=> ${targetVector}::vector) < ${threshold})
      )
    ORDER BY best_distance ASC
    LIMIT ${limit}
  `);

  const candidates: RetrievalCandidate[] = result.rows.map((row: any) => ({
    snapshotId: row.snapshot_id as string,
    projectId: row.project_id as string,
    thesisText: (row.thesis_text as string) || '',
    notesContent: (row.notes_content as string) || '',
    noteSnapshotId: (row.matched_note_snapshot_id as string) || null,
    notePath: (row.matched_note_path as string) || null,
    noteTitle: (row.matched_note_title as string) || null,
    noteSnippet: (row.matched_note_snippet as string) || null,
    distance: Number(row.best_distance),
    level: row.matched_note_path ? 'note' : 'project',
  }));
  const withinThreshold = result.rows.length > 0 ? Number((result.rows[0] as any).within_threshold) : 0;
  return { candidates, withinThreshold, threshold, limit };
}

/** Every note of a project snapshot with its full text, for the notes context of a prompt. */
export async function snapshotNotes(projectSnapshotId: string): Promise<ContextNote[]> {
  const rows = await db.select({
    path: projectNoteSnapshots.notePath,
    title: projectNoteSnapshots.noteTitle,
    text: projectNoteSnapshots.contentSnippet,
  }).from(projectNoteSnapshots).where(eq(projectNoteSnapshots.projectSnapshotId, projectSnapshotId));
  return rows.map(r => ({ path: r.path, title: r.title, text: r.text ?? '' }));
}

/**
 * Distance from the article to each note of a snapshot, only for notes embedded with `embedModel`
 * (I7). Notes without a comparable embedding get none and go last.
 */
export async function rankSnapshotNotes(
  projectSnapshotId: string,
  contentEmbedding: number[],
  embedModel: string = env.EMBED_MODEL,
): Promise<Map<string, number>> {
  const targetVector = `[${contentEmbedding.join(',')}]`;
  const result = await db.execute(sql`
    SELECT note_path, (embedding <=> ${targetVector}::vector) AS distance
    FROM ${projectNoteSnapshots}
    WHERE project_snapshot_id = ${projectSnapshotId}
      AND embedding IS NOT NULL
      AND embedding_model = ${embedModel}
  `);
  return new Map(result.rows.map((r: any) => [r.note_path as string, Number(r.distance)]));
}

/**
 * The notes context for one project and article: whole when it fits NOTES_CONTEXT_CHARS, otherwise
 * ranked by distance to the article. Snapshots without note rows (older data, tests) fall back to
 * the project's notes text, cut to the budget.
 */
export async function projectNotesContext(
  projectSnapshotId: string,
  contentEmbedding: number[] | null,
  fallbackText: string,
  lang: Language,
  embedModel: string = env.EMBED_MODEL,
): Promise<NotesContext> {
  const notes = await snapshotNotes(projectSnapshotId);
  if (notes.length === 0) return { text: fallbackText.substring(0, NOTES_CONTEXT_CHARS), included: 0, omitted: 0 };
  if (notesTextChars(notes) > NOTES_CONTEXT_CHARS && contentEmbedding) {
    const distances = await rankSnapshotNotes(projectSnapshotId, contentEmbedding, embedModel);
    for (const note of notes) note.distance = distances.get(note.path) ?? null;
  }
  return buildNotesContext(notes, NOTES_CONTEXT_CHARS, lang);
}
