import * as fs from 'fs/promises';
import { getLogger, pathKey } from '../observability/logger';

const log = getLogger('parser');

/** Notes left out of a project, or changed on the way in; shown to the owner, never sent to a model. */
export type NoteIssueReason = 'too_large' | 'binary' | 'cut' | 'binary_removed';

export interface ProjectMarkdown {
  hasProjectTag: boolean;
  title: string;
  thesis: string;
  rawContent: string;
  /** Size of the file on disk. */
  bytes: number;
  /** The note was not read: too large, or not text. Its title is the file name and its text is empty. */
  skipped?: 'too_large' | 'binary';
  /** The note was read but its text changed: cut at MAX_NOTE_CHARS, or embedded binary data removed. */
  issues: ('cut' | 'binary_removed')[];
}

/** Guards against pathological files; a real note is far shorter. */
export const MAX_NOTE_CHARS = 200_000;

/** Files larger than this are not read at all (an export or a dump, not a note). */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;

/** The text of a note that feeds embeddings and the project thesis, unchanged since note text was first cut at this length. */
export const EMBED_NOTE_CHARS = 4000;

/** Stands in for embedded binary data, so its size is visible to the model without its bytes. */
export const BINARY_PLACEHOLDER = '[datos binarios omitidos]';

// Pasted images and attachments: data URIs, and long runs of base64 with no spaces (no word or URL is that long)
const DATA_URI = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const BASE64_RUN = /[A-Za-z0-9+/=]{1000,}/g;

/** NUL bytes, or many characters that failed to decode as UTF-8: not a text file. */
function looksBinary(text: string): boolean {
  if (text.includes('\0')) return true;
  const sample = text.slice(0, 100_000);
  const replaced = sample.split('\uFFFD').length - 1;
  return sample.length > 0 && replaced / sample.length > 0.1;
}

export function removeBinaryData(text: string): { text: string; removed: boolean } {
  const cleaned = text.replace(DATA_URI, BINARY_PLACEHOLDER).replace(BASE64_RUN, BINARY_PLACEHOLDER);
  return { text: cleaned, removed: cleaned !== text };
}

const fileTitle = (filePath: string) => filePath.replace(/\\/g, '/').split('/').pop()!.replace(/\.md$/i, '');

export async function parseMarkdownFile(filePath: string): Promise<ProjectMarkdown | null> {
  try {
    const { size: bytes } = await fs.stat(filePath);
    const skippedNote = (skipped: 'too_large' | 'binary'): ProjectMarkdown => ({
      hasProjectTag: false, title: fileTitle(filePath), thesis: '', rawContent: '', bytes, skipped, issues: [],
    });
    if (bytes > MAX_NOTE_BYTES) return skippedNote('too_large');

    const rawContent = await fs.readFile(filePath, 'utf-8');
    if (looksBinary(rawContent)) return skippedNote('binary');
    const hasProjectTag = hasInlineProjectTag(rawContent) || hasFrontmatterProjectTag(rawContent);

    // Strip YAML frontmatter strictly anchored at start of file
    const contentWithoutFm = rawContent.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n)?/, '');

    // Strip code blocks to avoid false positives for comments or headers inside code
    const contentWithoutCode = contentWithoutFm.replace(/```[\s\S]*?```/g, '');

    // Heuristics-based title extraction: first h1 outside code/frontmatter, or filename fallback
    let title = 'Untitled Note';
    const titleMatch = contentWithoutCode.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1].trim();
    } else {
      title = fileTitle(filePath);
    }

    // Extract text content ignoring headers anchored to line start and hashtags
    const textOnly = contentWithoutCode
      .replace(/^#+\s+.+$/gm, '') // Remove headers strictly at line start
      .replace(INLINE_PROJECT_TAG, '$1') // Remove the #project hashtag itself
      .trim();

    // Embedded images and attachments would fill prompts and embeddings with noise
    const { text: cleaned, removed } = removeBinaryData(textOnly);
    const issues: ProjectMarkdown['issues'] = [];
    if (removed) issues.push('binary_removed');
    if (cleaned.length > MAX_NOTE_CHARS) issues.push('cut');

    // The whole note is kept for the model's context; only the embedding input is cut (reconciler)
    const thesis = cleaned.substring(0, MAX_NOTE_CHARS);

    return {
      hasProjectTag,
      title,
      thesis,
      rawContent,
      bytes,
      issues,
    };
  } catch (err) {
    log.warn({ err, note: pathKey(filePath) }, 'Could not parse a markdown file');
    return null;
  }
}

// `#project` as a standalone hashtag (not `#projects`, not part of a URL fragment like `page#project`)
const INLINE_PROJECT_TAG = /(^|\s)#project(?![\w/-])/gm;

export function hasInlineProjectTag(rawContent: string): boolean {
  INLINE_PROJECT_TAG.lastIndex = 0;
  return INLINE_PROJECT_TAG.test(rawContent);
}

/**
 * Checks the YAML frontmatter `tags`/`tag` field for a `project` entry.
 * Supports `tags: project`, `tags: [a, project]` and block lists (`- project`).
 */
export function hasFrontmatterProjectTag(rawContent: string): boolean {
  const fm = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  const lines = fm[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(/^tags?:\s*(.*)$/i);
    if (!keyMatch) continue;

    const inline = keyMatch[1].trim();
    if (inline) {
      const values = inline.replace(/^\[|\]$/g, '').split(',');
      return values.some(v => normalizeTag(v) === 'project');
    }

    // Block list: subsequent indented `- value` lines
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s*-\s*(.+)$/);
      if (!item) break;
      if (normalizeTag(item[1]) === 'project') return true;
    }
    return false;
  }
  return false;
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^['"#]+|['"]+$/g, '').toLowerCase();
}
