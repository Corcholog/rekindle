import type { ActionStep } from '../db/schema';
import { Language } from '../ai/language';
import { NO_NOTE, ProjectNoteRef, ResolvedTarget, resolveTarget } from './targetFile';

/**
 * A suggested action as the model returns it: a one-sentence headline and up to MAX_ACTION_STEPS
 * steps, each a change in one note. Model output is untrusted: the number of steps and every
 * field's length are cut here, and a step's note is kept only if it is one of the project's notes
 * or the new note the action proposes (the same check as the target note, targetFile.ts).
 */

export const MAX_ACTION_STEPS = 4;
export const HEADLINE_CHARS = 300;
export const STEP_WHERE_CHARS = 160;
export const STEP_CHANGE_CHARS = 500;
export const STEP_TEXT_CHARS = 800;
export const REASONING_PART_CHARS = 1500;

export interface RawStep {
  note?: string | null;
  where?: string | null;
  change?: string | null;
  text?: string | null;
}

const cut = (value: string | null | undefined, max: number): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed.substring(0, max) : null;
};

function stepNote(proposed: string | null | undefined, notes: readonly ProjectNoteRef[], target: ResolvedTarget): { note: string | null; noteIsNew: boolean } {
  if (!proposed?.trim()) return { note: null, noteIsNew: false };
  const existing = resolveTarget(proposed, false, notes, null);
  if (existing.path !== NO_NOTE) return { note: existing.path, noteIsNew: false };
  if (target.isNew && resolveTarget(proposed, true, notes, null).path === target.path) return { note: target.path, noteIsNew: true };
  return { note: null, noteIsNew: false };
}

export function resolveSteps(raw: readonly RawStep[] | null | undefined, notes: readonly ProjectNoteRef[], target: ResolvedTarget): ActionStep[] {
  const steps: ActionStep[] = [];
  for (const step of raw ?? []) {
    const change = cut(step.change, STEP_CHANGE_CHARS);
    if (!change) continue;
    steps.push({ ...stepNote(step.note, notes, target), where: cut(step.where, STEP_WHERE_CHARS), change, text: cut(step.text, STEP_TEXT_CHARS) });
    if (steps.length === MAX_ACTION_STEPS) break;
  }
  return steps;
}

export function headline(value: string): string {
  return value.trim().substring(0, HEADLINE_CHARS);
}

/** The action as plain text, for prompts and readers without steps: the headline, then numbered steps. */
export function actionPlainText(head: string, steps: readonly ActionStep[] | null | undefined, lang: Language): string {
  if (!steps?.length) return head;
  const lines = steps.map((s, i) => {
    const place = [s.note, s.where].filter(Boolean).join(', ');
    const quote = s.text ? (lang === 'en' ? ` “${s.text}”` : ` «${s.text}»`) : '';
    return `${i + 1}. ${place ? `${place}: ` : ''}${s.change}${quote}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

/** The reasoning as plain text, connection first. */
export function reasoningPlainText(connection: string, gap: string | null | undefined): string {
  return [connection.trim(), gap?.trim()].filter(Boolean).join('\n\n');
}

export function reasoningPart(value: string | null | undefined): string | null {
  return cut(value, REASONING_PART_CHARS);
}
