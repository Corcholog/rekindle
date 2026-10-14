import * as fs from 'fs/promises';
import * as path from 'path';
import { db } from '../db';
import { projects, projectSnapshots } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { getDirectoryHash } from './hash';
import { parseMarkdownFile } from './parser';
import { sharedAiProvider } from '../ai/OllamaProvider';
import { enqueueProjectBacklogEvaluations } from '../evaluator';
import { PROJECT_DIR_NAMES } from '../config';

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
        if (lower.endsWith('.md') && lower !== 'suggestions.md') {
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
    console.log(`[Reconciler] Project ${normalizedPath} is already being reconciled. Queuing follow-up pass.`);
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
      })
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, existingProject.id))
      .orderBy(desc(projectSnapshots.capturedAt))
      .limit(1);

      if (latestSnapshot && latestSnapshot.embedding !== null) {
        // Truly up to date with valid embedding
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
    
    try {
      const mdFiles = await getProjectMarkdownFiles(projectPath);

      for (const file of mdFiles) {
        const parsed = await parseMarkdownFile(file.fullPath);
        if (parsed) {
          noteTitles.push(parsed.title);

          if (parsed.hasProjectTag && !foundTaggedThesis) {
            foundTaggedThesis = parsed.thesis;
            taggedNoteTitle = parsed.title;
          }

          if (parsed.thesis) {
            notesContent += `### Nota: ${parsed.title}\n${parsed.thesis}\n\n`;
          }
        }
      }
    } catch (error) {
      console.error(`Error reading project directory ${projectPath}:`, error);
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

    // Generar Embedding combinando el título del proyecto y las notas recopiladas
    const fullTextForEmbedding = `Proyecto: ${title}\n\n${notesContent || thesisText}`.substring(0, 6000);
    let embedding: number[] = [];
    try {
      embedding = await ollama.getEmbedding(fullTextForEmbedding);
    } catch (error) {
      console.error(`Failed to generate embedding for project ${title}:`, error);
    }

    // If embedding failed, do NOT persist currentHash so next reconcile will retry
    if (embedding.length === 0) {
      console.warn(`[Reconciler] Embedding generation failed for project "${title}". Skipping snapshot/hash persistence to retry on next cycle.`);
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
      await tx.insert(projectSnapshots).values({
        projectId: pid,
        treeHash: currentHash,
        thesisText,
        notesContent,
        noteTitles,
        embedding,
      });

      return pid;
    });

    // Option A: Automatically evaluate matching unevaluated past contents for this project
    try {
      await enqueueProjectBacklogEvaluations(projectId);
    } catch (err) {
      console.error(`[Reconciler] Backlog evaluation error for project ${projectId}:`, err);
    }

    console.log(`[Reconciler] Project synchronized: ${title} (${relativePath}) with ${noteTitles.length} notes`);
  } finally {
    activeProjectReconciliations.delete(normalizedPath);
    if (pendingProjectReconciliations.delete(normalizedPath)) {
      setImmediate(() => {
        reconcileProject(projectPath, vaultPath, force).catch(err => {
          console.error(`[Reconciler] Error in queued follow-up reconciliation for ${normalizedPath}:`, err);
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
        console.error(`Error scanning ${targetPath}:`, err);
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
        console.error(`[Reconciler] Backlog evaluation error on reactivating project ${proj.id}:`, err);
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
