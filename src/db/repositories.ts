import { eq, and } from 'drizzle-orm';
import { db } from './index';
import { contents, projects, projectSnapshots, evaluations, actionSuggestions } from './schema';

export async function insertContent(data: typeof contents.$inferInsert) {
  return db.insert(contents).values(data).returning();
}

export async function findProjectByPath(folderPath: string) {
  return db.select().from(projects).where(eq(projects.folderPath, folderPath)).limit(1);
}

export async function upsertProject(data: typeof projects.$inferInsert) {
  return db.insert(projects)
    .values(data)
    .onConflictDoUpdate({
      target: projects.folderPath,
      set: {
        title: data.title,
        currentHash: data.currentHash,
        isActive: data.isActive,
        updatedAt: new Date(),
      }
    }).returning();
}

export async function insertProjectSnapshot(data: typeof projectSnapshots.$inferInsert) {
  return db.insert(projectSnapshots).values(data).returning();
}

export async function insertEvaluation(data: typeof evaluations.$inferInsert) {
  return db.insert(evaluations).values(data).returning();
}

export async function insertActionSuggestion(data: typeof actionSuggestions.$inferInsert) {
  return db.insert(actionSuggestions).values(data).returning();
}
