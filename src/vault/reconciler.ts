import * as fs from 'fs/promises';
import * as path from 'path';
import { db } from '../db';
import { projects, projectSnapshots } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { getDirectoryHash } from './hash';
import { parseMarkdownFile } from './parser';
import { OllamaProvider } from '../ai/OllamaProvider';
import { enqueueProjectBacklogEvaluations } from '../evaluator';

const ollama = new OllamaProvider();

export async function reconcileProject(projectPath: string, vaultPath: string, force = false): Promise<void> {
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

  // Parse all markdown files in the project directory
  let thesisText = '';
  let notesContent = '';
  let title = path.basename(projectPath);
  const noteTitles: string[] = [];
  let foundProjectMd = false;
  let foundTaggedThesis = '';
  
  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    // Prioritize project.md for project title and core thesis resolution
    entries.sort((a, b) => {
      if (a.name.toLowerCase() === 'project.md') return -1;
      if (b.name.toLowerCase() === 'project.md') return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'suggestions.md') {
        const fullPath = path.join(projectPath, entry.name);
        const parsed = await parseMarkdownFile(fullPath);
        
        if (parsed) {
          noteTitles.push(parsed.title);
          const isProjectMd = entry.name.toLowerCase() === 'project.md';

          if (isProjectMd) {
            title = parsed.title;
            thesisText = parsed.thesis;
            foundProjectMd = true;
          } else if (parsed.hasProjectTag && !foundProjectMd) {
            title = parsed.title;
            foundTaggedThesis = parsed.thesis;
          }

          if (parsed.thesis) {
            notesContent += `### Nota: ${parsed.title}\n${parsed.thesis}\n\n`;
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error reading project directory ${projectPath}:`, error);
    return;
  }

  // If no project.md found, use tagged note thesis, or first note as fallback
  if (!thesisText) {
    if (foundTaggedThesis) {
      thesisText = foundTaggedThesis;
    } else if (notesContent) {
      thesisText = notesContent.substring(0, 500).trim();
    } else {
      thesisText = 'Proyecto sin contenido. Agrega notas markdown dentro de la carpeta.';
    }
  }

  // Generar Embedding combinando la tesis central y las notas del proyecto
  const fullTextForEmbedding = `${thesisText}\n\n${notesContent}`.substring(0, 6000);
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
}

export async function bootReconcile(vaultPath: string, force = false): Promise<void> {
  const targetDirs = ['Projects', 'Proyectos'];
  
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
