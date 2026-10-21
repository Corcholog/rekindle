import * as fs from 'fs/promises';
import { getLogger, pathKey } from '../observability/logger';

const log = getLogger('parser');

export interface ProjectMarkdown {
  hasProjectTag: boolean;
  title: string;
  thesis: string;
  rawContent: string;
}

/** Guards against pathological files; a real note is far shorter. */
export const MAX_NOTE_CHARS = 200_000;

/** The text of a note that feeds embeddings and the project thesis, unchanged since note text was first cut at this length. */
export const EMBED_NOTE_CHARS = 4000;

export async function parseMarkdownFile(filePath: string): Promise<ProjectMarkdown | null> {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
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
      const parts = filePath.replace(/\\/g, '/').split('/');
      title = parts[parts.length - 1].replace(/\.md$/i, '');
    }

    // Extract text content ignoring headers anchored to line start and hashtags
    const textOnly = contentWithoutCode
      .replace(/^#+\s+.+$/gm, '') // Remove headers strictly at line start
      .replace(INLINE_PROJECT_TAG, '$1') // Remove the #project hashtag itself
      .trim();

    // The whole note is kept for the model's context; only the embedding input is cut (reconciler)
    const thesis = textOnly.substring(0, MAX_NOTE_CHARS);

    return {
      hasProjectTag,
      title,
      thesis,
      rawContent
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
