import { sql } from 'drizzle-orm';
import { db } from '../db';
import { projects, projectSnapshots, projectNoteSnapshots } from '../db/schema';
import { VECTOR_DISTANCE_THRESHOLD, TOP_K_PROJECTS_LIMIT, env } from '../config';

export interface RetrievalCandidate {
  snapshotId: string;
  projectId: string;
  thesisText: string;
  notesContent: string;
  /** Best-matching note of the project, when a note is closer than the threshold. */
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

/**
 * Step 1 of the evaluation: active projects whose latest snapshot, or one of its notes, lies
 * within `threshold` of the content embedding. Only embeddings from `embedModel` are compared
 * (invariant I7). Returns one candidate per project, closest first.
 */
export async function retrieveCandidates(
  contentEmbedding: number[],
  options: RetrievalOptions = {},
): Promise<RetrievalCandidate[]> {
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
      mn.note_path AS matched_note_path,
      mn.note_title AS matched_note_title,
      mn.content_snippet AS matched_note_snippet,
      COALESCE(mn.note_distance, (ls.embedding <=> ${targetVector}::vector)) AS best_distance
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

  return result.rows.map((row: any) => ({
    snapshotId: row.snapshot_id as string,
    projectId: row.project_id as string,
    thesisText: (row.thesis_text as string) || '',
    notesContent: (row.notes_content as string) || '',
    notePath: (row.matched_note_path as string) || null,
    noteTitle: (row.matched_note_title as string) || null,
    noteSnippet: (row.matched_note_snippet as string) || null,
    distance: Number(row.best_distance),
    level: row.matched_note_path ? 'note' : 'project',
  }));
}
