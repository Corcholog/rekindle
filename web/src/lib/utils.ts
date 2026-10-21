import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Only http(s) links ever become an href; anything else (javascript:, data:) is dropped. */
/** An evaluation's reasoning as shown: connection first, then what it lacks, or the model's own text. */
export function reasoningText(ev: { triageReasoning?: string | null; reasoningConnection?: string | null; reasoningGap?: string | null }): string | null {
  if (ev.reasoningConnection) return [ev.reasoningConnection, ev.reasoningGap].filter(Boolean).join('\n\n');
  return ev.triageReasoning ?? null;
}

export function safeHref(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}
