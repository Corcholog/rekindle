import * as fs from 'fs/promises';
import * as path from 'path';
import { db } from '../db';
import { projects, projectSnapshots, projectNoteSnapshots, projectNoteChunks, NoteIssue } from '../db/schema';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { chunkNote, chunkEmbeddingInput, NoteChunk } from './chunker';
import { getDirectoryHash } from './hash';
import { parseMarkdownFile, EMBED_NOTE_CHARS } from './parser';
import { sharedAiProvider } from '../ai/aiProvider';
import { enqueueProjectBacklogEvaluations } from '../evaluator';
import { PROJECT_DIR_NAMES, env } from '../config';
import { newestModification } from './dormancy';
import { isGeneratedNote } from './generatedNotes';
import { getLogger, pathKey } from '../observability/logger';

const log = getLogger('reconciler');

const ollama = sharedAiProvider;
const activeProjectReconciliations = new Set<string>();
const pendingProjectReconciliations = new Set<string>();

async function getProjectMarkdownFiles(projectPath: string): Promise<{ fullPath: string; relPath: string; name: string }[]> {
  const result: { fullPath: string; relPath: string; name: string }[] = [];

  async function walk(currentDir: string) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // Ignore hidden directories like .obsidian, .git
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        // Rekindle's own output (suggestions.md, generated briefs) never feeds back into project context
        if (lower.endsWith('.md') && lower !== 'suggestions.md' && !(await isGeneratedNote(full))) {
          const rel = path.relative(projectPath, full).replace(/\\/g, '/');
          result.push({ fullPath: full, relPath: rel, name: entry.name });
        }
      }
    }
  }

  await walk(projectPath);
  return result.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export async function reconcileProject(projectPath: string, vaultPath: string, force = false): Promise<void> {
  const normalizedPath = path.resolve(projectPath);
  if (activeProjectReconciliations.has(normalizedPath)) {
    log.info({ project: pathKey(normalizedPath) }, 'Reconciliation already running; queued a follow-up pass');
    pendingProjectReconciliations.add(normalizedPath);
    return;
  }
  activeProjectReconciliations.add(normalizedPath);

  try {
    const currentHash = await getDirectoryHash(projectPath);
    if (!currentHash) return; // Project might be empty or deleted

    const relativePath = path.relative(vaultPath, projectPath).replace(/\\/g, '/');
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return;
    }

    // Check if project exists in DB
    const existingProject = await db.query.projects.findFirst({
      where: eq(projects.folderPath, relativePath),
    });

    if (!force && existingProject && existingProject.currentHash === currentHash) {
      // Check if the latest snapshot actually has an embedding. If it is null, we must re-embed!
      const [latestSnapshot] = await db.select({
        id: projectSnapshots.id,
        embedding: projectSnapshots.embedding,
        notesModifiedAt: projectSnapshots.notesModifiedAt,
      })
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, existingProject.id))
      .orderBy(desc(projectSnapshots.capturedAt))
      .limit(1);

      if (latestSnapshot && latestSnapshot.embedding !== null) {
        // The folder is back with the same notes, e.g. after the vault's drive was unmounted and
        // mounted again (the watcher marks a removed folder inactive): active again, no new snapshot,
        // so nothing is re-evaluated (F-15)
        if (!existingProject.isActive) {
          await db.update(projects).set({ isActive: true, updatedAt: new Date() }).where(eq(projects.id, existingProject.id));
          log.info({ project: pathKey(normalizedPath) }, 'Project folder is back unchanged; marked active');
        }
        // Truly up to date. Snapshots from before dormancy tracking get their date filled in once.
        if (!latestSnapshot.notesModifiedAt) {
          const notesModifiedAt = await newestModification((await getProjectMarkdownFiles(projectPath)).map(f => f.fullPath));
          if (notesModifiedAt) {
            await db.update(projectSnapshots).set({ notesModifiedAt }).where(eq(projectSnapshots.id, latestSnapshot.id));
          }
        }
        return;
      }
    }


    // Parse all markdown files in the project directory (including subfolders)
    let thesisText = '';
    let notesContent = '';
    let title = path.basename(projectPath);
    const noteTitles: string[] = [];
    let foundTaggedThesis = '';
    let taggedNoteTitle = '';
    const parsedNotes: {
      notePath: string;
      noteTitle: string;
      contentSnippet: string;
      /** The note with its headings, for chunking a long note. */
      structured: string;
    }[] = [];
    
    const noteIssues: NoteIssue[] = [];
    let notesModifiedAt: Date | null = null;
    try {
      const mdFiles = await getProjectMarkdownFiles(projectPath);
      notesModifiedAt = await newestModification(mdFiles.map(f => f.fullPath));

      for (const file of mdFiles) {
        const parsed = await parseMarkdownFile(file.fullPath);
        if (parsed?.skipped) {
          // Never read into prompts or embeddings: an export, a dump or a binary file
          noteIssues.push({ path: file.relPath, reason: parsed.skipped, bytes: parsed.bytes });
          continue;
        }
        if (parsed) {
          for (const reason of parsed.issues) noteIssues.push({ path: file.relPath, reason, bytes: parsed.bytes });
          noteTitles.push(parsed.title);

          // Embedding inputs and the thesis keep the cut text, so vectors do not move (I7, staleness)
          const embedText = parsed.thesis.substring(0, EMBED_NOTE_CHARS);
          if (parsed.hasProjectTag && !foundTaggedThesis) {
            foundTaggedThesis = embedText;
            taggedNoteTitle = parsed.title;
          }

          if (embedText) {
            notesContent += `### Nota: ${parsed.title}\n${embedText}\n\n`;
          }

          parsedNotes.push({
            notePath: file.relPath,
            noteTitle: parsed.title,
            contentSnippet: parsed.thesis || '',
            structured: parsed.structured || '',
          });
        }
      }
    } catch (error) {
      log.error({ err: error, project: pathKey(normalizedPath) }, 'Reading the project folder failed');
      return;
    }

    // Determine project title & core focus:
    // If a note has explicit #project tag, use its thesis as core focus and optionally its title
    if (foundTaggedThesis) {
      thesisText = foundTaggedThesis;
      if (taggedNoteTitle && taggedNoteTitle !== 'Untitled Note') {
        title = taggedNoteTitle;
      }
    } else if (notesContent) {
      thesisText = notesContent.substring(0, 800).trim();
    } else {
      thesisText = 'Proyecto sin contenido. Agrega notas markdown dentro de la carpeta.';
    }

    // Generate individual embeddings for each note (Hierarchical / Note-Level Embeddings)
    const noteSnapshotsData: {
      notePath: string;
      noteTitle: string;
      contentSnippet: string;
      embedding: number[];
    }[] = [];

    for (const note of parsedNotes) {
      const textForNote = `Nota: ${note.noteTitle}\n\n${note.contentSnippet}`.substring(0, EMBED_NOTE_CHARS);
      try {
        const noteEmb = await ollama.getEmbedding(textForNote);
        if (noteEmb.length > 0) {
          noteSnapshotsData.push({
            notePath: note.notePath,
            noteTitle: note.noteTitle,
            contentSnippet: note.contentSnippet,
            embedding: noteEmb,
          });
        }
      } catch (err) {
        log.warn({ err, project: pathKey(normalizedPath), note: pathKey(note.notePath) }, 'Note embedding failed');
      }
    }

    // Long notes are also embedded section by section (chunker.ts). A piece whose text is unchanged
    // since an earlier snapshot of the project reuses that embedding, so an edit re-embeds only the
    // pieces it touched. Embeddings stay local (I3) and of one model (I7).
    const chunksByNote = new Map<string, (NoteChunk & { embedding: number[] })[]>();
    const pending = parsedNotes.map(note => ({ note, chunks: chunkNote(note.noteTitle, note.structured, EMBED_NOTE_CHARS) })).filter(n => n.chunks.length > 0);
    if (pending.length > 0) {
      const hashes = pending.flatMap(n => n.chunks.map(c => c.hash));
      const known = new Map<string, number[]>();
      if (existingProject) {
        const rows = await db.select({ hash: projectNoteChunks.contentHash, embedding: projectNoteChunks.embedding })
          .from(projectNoteChunks)
          .where(and(eq(projectNoteChunks.projectId, existingProject.id), eq(projectNoteChunks.embeddingModel, env.EMBED_MODEL), inArray(projectNoteChunks.contentHash, hashes)));
        for (const row of rows) known.set(row.hash, row.embedding as number[]);
      }
      for (const { note, chunks } of pending) {
        const embedded: (NoteChunk & { embedding: number[] })[] = [];
        for (const chunk of chunks) {
          let embedding = known.get(chunk.hash);
          if (!embedding) {
            try {
              embedding = await ollama.getEmbedding(chunkEmbeddingInput(note.noteTitle, chunk));
              known.set(chunk.hash, embedding);
            } catch (err) {
              log.warn({ err, project: pathKey(normalizedPath), note: pathKey(note.notePath) }, 'Embedding a note section failed');
              continue;
            }
          }
          if (embedding.length > 0) embedded.push({ ...chunk, embedding });
        }
        chunksByNote.set(note.notePath, embedded);
      }
    }

    // Generar Embedding colectivo combinando el título del proyecto y las notas recopiladas
    const fullTextForEmbedding = `Proyecto: ${title}\n\n${notesContent || thesisText}`.substring(0, 6000);
    let embedding: number[] = [];
    try {
      embedding = await ollama.getEmbedding(fullTextForEmbedding);
    } catch (error) {
      log.error({ err: error, project: pathKey(normalizedPath) }, 'Project embedding failed');
    }

    // If embedding failed, do NOT persist currentHash so next reconcile will retry
    if (embedding.length === 0) {
      log.warn({ project: pathKey(normalizedPath) }, 'No project embedding; snapshot not saved, will retry on the next change');
      return;
    }

    const projectId = await db.transaction(async (tx) => {
      let pid: string;
      if (existingProject) {
        pid = existingProject.id;
        await tx.update(projects)
          .set({ currentHash, updatedAt: new Date(), title, isActive: true })
          .where(eq(projects.id, pid));
      } else {
        const [inserted] = await tx.insert(projects)
          .values({
            folderPath: relativePath,
            title,
            currentHash,
            isActive: true,
          })
          .returning({ id: projects.id });
        pid = inserted.id;
      }

      // Create new snapshot
      const [snap] = await tx.insert(projectSnapshots).values({
        projectId: pid,
        treeHash: currentHash,
        thesisText,
        notesContent,
        noteTitles,
        embedding,
        embeddingModel: env.EMBED_MODEL,
        notesModifiedAt,
        noteIssues,
      }).returning({ id: projectSnapshots.id });

      // Insert hierarchical note-level snapshots
      if (noteSnapshotsData.length > 0) {
        const noteRows = await tx.insert(projectNoteSnapshots).values(
          noteSnapshotsData.map(nd => ({
            projectSnapshotId: snap.id,
            projectId: pid,
            notePath: nd.notePath,
            noteTitle: nd.noteTitle,
            contentSnippet: nd.contentSnippet,
            embedding: nd.embedding,
            embeddingModel: env.EMBED_MODEL,
          }))
        ).returning({ id: projectNoteSnapshots.id, notePath: projectNoteSnapshots.notePath });

        const chunkRows = noteRows.flatMap(row => (chunksByNote.get(row.notePath) ?? []).map(chunk => ({
          noteSnapshotId: row.id,
          projectSnapshotId: snap.id,
          projectId: pid,
          chunkIndex: chunk.index,
          heading: chunk.heading,
          content: chunk.text,
          contentHash: chunk.hash,
          embedding: chunk.embedding,
          embeddingModel: env.EMBED_MODEL,
        })));
        if (chunkRows.length > 0) await tx.insert(projectNoteChunks).values(chunkRows);
      }

      return pid;
    });

    // Option A: Automatically evaluate matching unevaluated past contents for this project
    try {
      await enqueueProjectBacklogEvaluations(projectId);
    } catch (err) {
      log.error({ err, projectId }, 'Enqueueing backlog evaluations failed');
    }

    log.info({ projectId, notes: noteTitles.length }, 'Project synchronized');
  } finally {
    activeProjectReconciliations.delete(normalizedPath);
    if (pendingProjectReconciliations.delete(normalizedPath)) {
      setImmediate(() => {
        reconcileProject(projectPath, vaultPath, force).catch(err => {
          log.error({ err, project: pathKey(normalizedPath) }, 'Follow-up reconciliation failed');
        });
      });
    }
  }
}

export async function bootReconcile(vaultPath: string, force = false): Promise<void> {
  const targetDirs = PROJECT_DIR_NAMES;
  
  for (const dirName of targetDirs) {
    const targetPath = path.join(vaultPath, dirName);
    try {
      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const projectPath = path.join(targetPath, entry.name);
          await reconcileProject(projectPath, vaultPath, force);
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        log.error({ err, folder: dirName }, 'Scanning the projects folder failed');
      }
    }
  }
}

export interface ProjectSyncStatus {
  id: string;
  title: string;
  folderPath: string;
  isActive: boolean;
  existsOnDisk: boolean;
}

export async function reconcileAllProjects(vaultPath: string, force = false): Promise<ProjectSyncStatus[]> {
  await bootReconcile(vaultPath, force);

  const allProjects = await db.select().from(projects);
  const syncStatuses: ProjectSyncStatus[] = [];

  for (const proj of allProjects) {
    const diskPath = path.join(vaultPath, proj.folderPath);
    let existsOnDisk = false;
    try {
      const stat = await fs.stat(diskPath);
      existsOnDisk = stat.isDirectory();
    } catch {
      existsOnDisk = false;
    }

    if (!existsOnDisk && proj.isActive) {
      await db.update(projects).set({ isActive: false, updatedAt: new Date() }).where(eq(projects.id, proj.id));
      proj.isActive = false;
    } else if (existsOnDisk && !proj.isActive) {
      await db.update(projects).set({ isActive: true, updatedAt: new Date() }).where(eq(projects.id, proj.id));
      proj.isActive = true;
      // Option A: Automatically trigger backlog evaluation when project flips to active
      try {
        await enqueueProjectBacklogEvaluations(proj.id);
      } catch (err) {
        log.error({ err, projectId: proj.id }, 'Enqueueing backlog evaluations for a reactivated project failed');
      }
    }

    syncStatuses.push({
      id: proj.id,
      title: proj.title,
      folderPath: proj.folderPath,
      isActive: proj.isActive,
      existsOnDisk,
    });
  }

  return syncStatuses;
}
