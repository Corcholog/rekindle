import * as fs from 'fs/promises';
import * as path from 'path';
import { db } from '../db';
import { actionSuggestions, projects, contents } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { sanitizeForVault } from './sanitize';

/**
 * Writeback policy: ONLY suggestions explicitly accepted by the user are written to the vault.
 * Pending or discarded suggestions never touch Obsidian.
 */

type WritableSuggestion = {
  id: string;
  actionType: string;
  observation: string;
  suggestedAction: string;
  userFeedback: string | null;
  sourceUri: string | null;
  sourceTitle: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  counter_argument: 'CONTRAARGUMENTO',
  unblocker: 'DESBLOQUEO',
  evidence_citation: 'CITA DE EVIDENCIA',
  narrative_bridge: 'PUENTE NARRATIVO',
  other: 'OTRO',
};

export function formatAcceptedCallout(sug: WritableSuggestion, date = new Date()): string {
  const typeLabel = ACTION_LABELS[sug.actionType] ?? sug.actionType.toUpperCase();

  // Escape bracket characters in link text and parentheses in URL to prevent breaking markdown link syntax
  let link = 'Fuente desconocida';
  if (sug.sourceUri && /^https?:\/\//i.test(sug.sourceUri)) {
    const safeTitle = sanitizeForVault(sug.sourceTitle || 'Fuente', 300).replace(/\n/g, ' ').replace(/[[\]]/g, '\\$&');
    const safeUri = sug.sourceUri.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
    link = `[${safeTitle}](${safeUri})`;
  }

  // Prefix every line with "> " so markdown callout structure remains unbroken.
  // Model text comes from untrusted pages, so it is sanitized first.
  const prefixLines = (label: string, text: string) => {
    const lines = sanitizeForVault(text).trim().split('\n');
    if (lines.length === 0) return `> **${label}:**\n`;
    const firstLine = `> **${label}:** ${lines[0]}\n`;
    const remainingLines = lines.slice(1).map(l => `> ${l}\n`).join('');
    return firstLine + remainingLines;
  };

  let callout = `\n\n> [!tip] Sugerencia Aceptada: ${typeLabel} (${date.toLocaleDateString()})\n`;
  callout += prefixLines('Acción', sug.suggestedAction);
  callout += prefixLines('Observación', sug.observation);
  callout += `> **Fuente:** ${link}\n`;
  if (sug.userFeedback) {
    callout += prefixLines('Feedback', sug.userFeedback);
  }
  return callout;
}

const writableSelection = {
  id: actionSuggestions.id,
  actionType: actionSuggestions.actionType,
  observation: actionSuggestions.observation,
  suggestedAction: actionSuggestions.suggestedAction,
  userFeedback: actionSuggestions.userFeedback,
  sourceUri: contents.uri,
  sourceTitle: contents.title,
};

async function appendToProjectFile(folderPath: string, vaultPath: string, markdown: string): Promise<string> {
  const suggestionsFilePath = path.join(vaultPath, folderPath, 'suggestions.md');
  await fs.mkdir(path.dirname(suggestionsFilePath), { recursive: true });
  await fs.appendFile(suggestionsFilePath, markdown, 'utf-8');
  return suggestionsFilePath;
}

/**
 * Escribe una sugerencia aceptada en el Vault como Callout (> [!tip]) de Obsidian.
 * Idempotente: reclama la sugerencia atómicamente antes de escribir.
 * @returns true si se escribió en este llamado.
 */
export async function writeAcceptedSuggestionToVault(suggestionId: string, vaultPath: string): Promise<boolean> {
  // Claim the row first to prevent concurrent duplicate writebacks
  const [claimed] = await db.update(actionSuggestions)
    .set({ writtenToVault: true })
    .where(and(
      eq(actionSuggestions.id, suggestionId),
      eq(actionSuggestions.status, 'accepted'),
      eq(actionSuggestions.writtenToVault, false),
    ))
    .returning({ id: actionSuggestions.id });

  if (!claimed) return false;

  const [sug] = await db.select({ ...writableSelection, folderPath: projects.folderPath })
    .from(actionSuggestions)
    .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
    .leftJoin(contents, eq(actionSuggestions.contentId, contents.id))
    .where(eq(actionSuggestions.id, suggestionId))
    .limit(1);

  if (!sug) return false;

  try {
    const filePath = await appendToProjectFile(sug.folderPath, vaultPath, formatAcceptedCallout(sug));
    console.log(`[VaultUpdater] Accepted suggestion ${suggestionId} written to ${filePath}`);
    return true;
  } catch (err) {
    // Revert claim if disk write failed
    await db.update(actionSuggestions)
      .set({ writtenToVault: false })
      .where(eq(actionSuggestions.id, suggestionId));
    throw err;
  }
}

/**
 * Recovery path (used by the sync_suggestions worker): writes every accepted suggestion
 * of a project that has not reached the vault yet (e.g. a previous writeback failed).
 */
export async function syncProjectSuggestions(projectId: string, vaultPath: string): Promise<number> {
  const [projectRecord] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!projectRecord) return 0;

  const unwritten = await db.select({ id: actionSuggestions.id })
    .from(actionSuggestions)
    .where(and(
      eq(actionSuggestions.projectId, projectId),
      eq(actionSuggestions.status, 'accepted'),
      eq(actionSuggestions.writtenToVault, false),
    ));

  if (unwritten.length === 0) {
    console.log(`[VaultUpdater] No accepted suggestions pending writeback for project ${projectId}`);
    return 0;
  }

  let writtenCount = 0;
  for (const sug of unwritten) {
    const success = await writeAcceptedSuggestionToVault(sug.id, vaultPath);
    if (success) writtenCount++;
  }

  console.log(`[VaultUpdater] Recovered ${writtenCount} accepted suggestions for project ${projectId}`);
  return writtenCount;
}
