import { describe, it, expect, afterAll } from 'vitest';
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

describe('Vault parser: oversized and binary notes', () => {
  const dirs: string[] = [];
  const write = async (name: string, content: string | Buffer) => {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-parser-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, content);
    return file;
  };
  afterAll(async () => {
    const fs = await import('fs/promises');
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not read a file over the size limit', async () => {
    const { parseMarkdownFile, MAX_NOTE_BYTES } = await import('../src/vault/parser');
    const file = await write('export.md', `# Export\n${'x'.repeat(MAX_NOTE_BYTES)}`);
    expect(await parseMarkdownFile(file)).toMatchObject({ skipped: 'too_large', title: 'export', thesis: '', bytes: MAX_NOTE_BYTES + 9 });
  });

  it('leaves out a file that is not text', async () => {
    const { parseMarkdownFile } = await import('../src/vault/parser');
    expect(await parseMarkdownFile(await write('foto.md', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a, 0x0a]))))
      .toMatchObject({ skipped: 'binary', thesis: '' });
    // Bytes that are not UTF-8 decode as replacement characters
    expect(await parseMarkdownFile(await write('latin.md', Buffer.alloc(500, 0xff)))).toMatchObject({ skipped: 'binary' });
  });

  it('replaces pasted images and base64 blobs, and keeps the rest of the note', async () => {
    const { parseMarkdownFile, BINARY_PLACEHOLDER } = await import('../src/vault/parser');
    const blob = 'QUJD'.repeat(500);
    const file = await write('ideas.md', `# Ideas\nUn faro en la niebla ![mapa](data:image/png;base64,${blob}) y más texto.\n\n${blob}\n\nFin de la nota.`);
    const parsed = await parseMarkdownFile(file);
    expect(parsed!.issues).toEqual(['binary_removed']);
    expect(parsed!.thesis).toContain('Un faro en la niebla');
    expect(parsed!.thesis).toContain('Fin de la nota.');
    expect(parsed!.thesis).not.toContain('QUJDQUJD');
    expect(parsed!.thesis.split(BINARY_PLACEHOLDER)).toHaveLength(3);
  });

  it('marks a note cut at the character limit, and leaves an ordinary note alone', async () => {
    const { parseMarkdownFile, MAX_NOTE_CHARS } = await import('../src/vault/parser');
    const long = await parseMarkdownFile(await write('largo.md', `# Largo\n${'palabra '.repeat(MAX_NOTE_CHARS / 8 + 100)}`));
    expect(long!.issues).toEqual(['cut']);
    expect(long!.thesis).toHaveLength(MAX_NOTE_CHARS);
    const plain = await parseMarkdownFile(await write('normal.md', '# Normal\nUna nota corriente con https://example.com/una/ruta/larga?x=1 y nada raro.'));
    expect(plain).toMatchObject({ issues: [] });
    expect(plain!.skipped).toBeUndefined();
  });
});
