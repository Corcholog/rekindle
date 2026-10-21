import * as fs from 'fs/promises';
import * as path from 'path';
import { db } from '../db';
import { actionSuggestions, projects, contents } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { sanitizeForVault } from './sanitize';
import { getLogger } from '../observability/logger';
import { Language, outputLanguage } from '../ai/language';
import { serverText } from '../i18n/serverText';

const log = getLogger('vault-updater');

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
  /** The note the suggestion is for, relative to the project folder (validated when the suggestion was made). */
  targetFile?: string | null;
  /** The note does not exist yet: the link lets the owner create it in Obsidian with one click. */
  targetIsNew?: boolean | null;
  /** The project's folder, relative to the vault, so the link resolves to that exact note. */
  folderPath?: string | null;
};

// Placeholder targets that are not notes: nothing to link to
const NOT_A_NOTE = new Set(['discarded', 'tentative', 'unknown', 'suggestions.md']);

/**
 * An Obsidian link to the note a suggestion is for: [[Projects/X/research/combat|combat]]. Null when
 * there is no note, or when its name holds characters that would break the link syntax.
 */
export function suggestedNoteLink(targetFile: string | null | undefined, folderPath?: string | null): string | null {
  if (!targetFile || NOT_A_NOTE.has(targetFile)) return null;
  const note = targetFile.replace(/\\/g, '/').replace(/\.md$/i, '');
  if (!note || /[[\]|#^\r\n]/.test(note) || note.startsWith('/') || note.split('/').includes('..')) return null;
  const full = folderPath ? `${folderPath.replace(/\/+$/, '')}/${note}` : note;
  return `[[${full}|${note.split('/').pop()}]]`;
}

/** Local date, whatever the machine's locale: dd/mm/yyyy in Spanish, yyyy-mm-dd in English. */
export function formatCalloutDate(date: Date, lang: Language = 'es'): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return lang === 'en'
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** Callout labels follow the output language; the hidden marker never changes (I5). */
export function formatAcceptedCallout(sug: WritableSuggestion, date = new Date(), lang: Language = outputLanguage()): string {
  const text = serverText(lang);
  const typeLabel = text.actionTypes[sug.actionType] ?? sug.actionType.toUpperCase();

  // Escape bracket characters in link text and parentheses in URL to prevent breaking markdown link syntax
  let link = text.unknownSource;
  if (sug.sourceUri && /^https?:\/\//i.test(sug.sourceUri)) {
    const safeTitle = sanitizeForVault(sug.sourceTitle || text.sourceFallbackTitle, 300).replace(/\n/g, ' ').replace(/[[\]]/g, '\\$&');
    const safeUri = sug.sourceUri.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
    link = `[${safeTitle}](${safeUri})`;
  }

  // Prefix every line with "> " so markdown callout structure remains unbroken.
  // Model text comes from untrusted pages, so it is sanitized first.
  const prefixLines = (label: string, body: string) => {
    const lines = sanitizeForVault(body).trim().split('\n');
    if (lines.length === 0) return `> **${label}:**\n`;
    const firstLine = `> **${label}:** ${lines[0]}\n`;
    const remainingLines = lines.slice(1).map(l => `> ${l}\n`).join('');
    return firstLine + remainingLines;
  };

  let callout = `\n\n> [!tip] ${text.calloutTitle}: ${typeLabel} (${formatCalloutDate(date, lang)})\n`;
  callout += prefixLines(text.calloutAction, sug.suggestedAction);
  callout += prefixLines(text.calloutObservation, sug.observation);
  const noteLink = suggestedNoteLink(sug.targetFile, sug.folderPath);
  if (noteLink) callout += `> **${sug.targetIsNew ? text.calloutNewNote : text.calloutNote}:** ${noteLink}\n`;
  callout += `> **${text.calloutSource}:** ${link}\n`;
  if (sug.userFeedback) {
    callout += prefixLines(text.calloutFeedback, sug.userFeedback);
  }
  // Hidden Obsidian comment used to detect an already-written callout after a crash
  callout += `> ${calloutMarker(sug.id)}\n`;
  return callout;
}

/** Sanitized model text cannot contain "%%", so it cannot forge another suggestion's marker. */
export function calloutMarker(suggestionId: string): string {
  return `%% rekindle:${suggestionId} %%`;
}

/** Callouts written before the rename (when the project was called Loom) carry this marker. */
export function legacyCalloutMarker(suggestionId: string): string {
  return `%% loom:${suggestionId} %%`;
}

/** I5: a callout counts as written under either marker, so a renamed install never repeats one. */
export function hasCallout(fileContent: string, suggestionId: string): boolean {
  return fileContent.includes(calloutMarker(suggestionId)) || fileContent.includes(legacyCalloutMarker(suggestionId));
}

const writableSelection = {
  id: actionSuggestions.id,
  actionType: actionSuggestions.actionType,
  observation: actionSuggestions.observation,
  suggestedAction: actionSuggestions.suggestedAction,
  userFeedback: actionSuggestions.userFeedback,
  targetFile: actionSuggestions.targetFile,
  targetIsNew: actionSuggestions.targetIsNew,
  sourceUri: contents.uri,
  sourceTitle: contents.title,
};

async function resolveSuggestionsFile(vaultPath: string, folderPath: string): Promise<string> {
  const root = path.resolve(vaultPath);
  const projectDir = path.resolve(root, folderPath);
  const rel = path.relative(root, projectDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`The project folder is outside the vault: ${folderPath}`);
  }
  // Never create project folders: after a vault switch the project may simply not be here
  const stat = await fs.stat(projectDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`La carpeta del proyecto no existe en el Vault: ${folderPath}`);
  }
  return path.join(projectDir, 'suggestions.md');
}

async function readIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Escribe una sugerencia aceptada en el Vault como Callout (> [!tip]) de Obsidian.
 * Idempotent across crashes and concurrent calls: the row is locked for the duration of the
 * write, and each callout carries a hidden marker. If the process died after appending but
 * before setting written_to_vault, the marker is found and the callout is not appended again.
 * @returns true if the callout was appended by this call.
 */
export async function writeAcceptedSuggestionToVault(suggestionId: string, vaultPath: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: actionSuggestions.id })
      .from(actionSuggestions)
      .where(and(
        eq(actionSuggestions.id, suggestionId),
        eq(actionSuggestions.status, 'accepted'),
        eq(actionSuggestions.writtenToVault, false),
      ))
      .for('update');
    if (!locked) return false;

    const [sug] = await tx.select({ ...writableSelection, folderPath: projects.folderPath })
      .from(actionSuggestions)
      .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
      .leftJoin(contents, eq(actionSuggestions.contentId, contents.id))
      .where(eq(actionSuggestions.id, suggestionId))
      .limit(1);
    if (!sug) return false;

    const filePath = await resolveSuggestionsFile(vaultPath, sug.folderPath);
    const alreadyWritten = hasCallout(await readIfExists(filePath), suggestionId);
    if (!alreadyWritten) {
      await fs.appendFile(filePath, formatAcceptedCallout(sug), 'utf-8');
      log.info({ suggestionId }, 'Accepted suggestion written to the vault');
    }

    await tx.update(actionSuggestions)
      .set({ writtenToVault: true })
      .where(eq(actionSuggestions.id, suggestionId));
    return !alreadyWritten;
  });
}

async function writePending(rows: { id: string }[], vaultPath: string): Promise<{ written: number; failed: number }> {
  let written = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (await writeAcceptedSuggestionToVault(row.id, vaultPath)) written++;
    } catch (err) {
      failed++;
      log.warn({ err, suggestionId: row.id }, 'Writeback still pending');
    }
  }
  return { written, failed };
}

/** Boot-time recovery: retries every accepted suggestion that has not reached the vault. */
export async function syncAllPendingWritebacks(vaultPath: string): Promise<number> {
  const pending = await db.select({ id: actionSuggestions.id })
    .from(actionSuggestions)
    .where(and(eq(actionSuggestions.status, 'accepted'), eq(actionSuggestions.writtenToVault, false)));
  if (pending.length === 0) return 0;

  const { written } = await writePending(pending, vaultPath);
  log.info({ written, pending: pending.length }, 'Writeback recovery finished');
  return written;
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
    log.info({ projectId }, 'No accepted suggestions pending writeback');
    return 0;
  }

  const { written: writtenCount, failed } = await writePending(unwritten, vaultPath);
  if (failed > 0) {
    // Let pg-boss retry the sync job
    throw new Error(`${failed} writeback(s) failed for project ${projectId}`);
  }

  log.info({ projectId, written: writtenCount }, 'Recovered accepted suggestions');
  return writtenCount;
}
