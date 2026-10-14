import { describe, it, expect } from 'vitest';
import { hasInlineProjectTag, hasFrontmatterProjectTag } from '../src/vault/parser';

describe('Vault parser: project tag detection', () => {
  it('detects a block-list frontmatter tag', () => {
    expect(hasFrontmatterProjectTag('---\ntags:\n  - idea\n  - project\n---\n# T')).toBe(true);
  });

  it('detects inline-array and scalar frontmatter tags', () => {
    expect(hasFrontmatterProjectTag('---\ntags: [idea, project]\n---\n')).toBe(true);
    expect(hasFrontmatterProjectTag('---\ntag: project\n---\n')).toBe(true);
    expect(hasFrontmatterProjectTag('---\ntags: ["#project"]\n---\n')).toBe(true);
  });

  it('detects a standalone #project hashtag', () => {
    expect(hasInlineProjectTag('Nota #project sobre agentes')).toBe(true);
    expect(hasInlineProjectTag('#project\n# Título')).toBe(true);
  });

  it('ignores notes that merely mention the word "project"', () => {
    // The old regex matched this: "tags:" anywhere + "project" anywhere later
    const note = '---\ntags:\n  - idea\n---\nEste project no es un proyecto etiquetado.';
    expect(hasFrontmatterProjectTag(note)).toBe(false);
    expect(hasInlineProjectTag(note)).toBe(false);
  });

  it('ignores similar hashtags and URL fragments', () => {
    expect(hasInlineProjectTag('#projects y #project-ideas')).toBe(false);
    expect(hasInlineProjectTag('ver https://site.com/page#project')).toBe(false);
  });
});
