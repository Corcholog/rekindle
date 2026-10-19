import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseMarkdownFile } from '../src/vault/parser';

// The demo vault is the first thing a new user sees. It must stay synthetic, Spanish and shaped
// the way the reconciler expects: one tagged note per project, plus more notes, some nested.


async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? markdownFiles(full) : e.name.endsWith('.md') ? [full] : [];
  }));
  return nested.flat();
}

const VAULTS = [
  { dir: 'demo_vault', articles: 'ARTICULOS_DEMO.md', wiki: 'https://es.wikipedia.org/wiki/' },
  { dir: 'demo_vault_en', articles: 'ARTICLES.md', wiki: 'https://en.wikipedia.org/wiki/' },
];

describe.each(VAULTS)('$dir', ({ dir, articles, wiki }) => {
  const DEMO = path.resolve(dir);

  it('has several projects, each with exactly one #project note and at least 3 notes', async () => {
    const projects = (await fs.readdir(path.join(DEMO, 'Projects'), { withFileTypes: true })).filter(e => e.isDirectory());
    expect(projects.length).toBeGreaterThanOrEqual(4);
    for (const project of projects) {
      const files = await markdownFiles(path.join(DEMO, 'Projects', project.name));
      expect(files.length, project.name).toBeGreaterThanOrEqual(3);
      const parsed = await Promise.all(files.map(f => parseMarkdownFile(f)));
      expect(parsed.filter(p => p?.hasProjectTag), project.name).toHaveLength(1);
      expect(parsed.every(p => p && p.thesis.length > 80), project.name).toBe(true);
    }
  });

  it('includes a nested folder so recursive indexing is visible', async () => {
    const all = await markdownFiles(path.join(DEMO, 'Projects'));
    expect(all.some(f => path.relative(path.join(DEMO, 'Projects'), f).split(path.sep).length > 2)).toBe(true);
  });

  it('lists only public Wikipedia articles for trying it out', async () => {
    const text = await fs.readFile(path.join(DEMO, articles), 'utf-8');
    const urls = text.match(/https?:\/\/\S+/g) ?? [];
    expect(urls.length).toBeGreaterThanOrEqual(6);
    expect(urls.every(u => u.startsWith(wiki))).toBe(true);
  });
});

describe('the two demo vaults', () => {
  it('have the same project structure, one translated from the other', async () => {
    const shape = async (dir: string) => {
      const projects = (await fs.readdir(path.join(dir, 'Projects'), { withFileTypes: true })).filter(e => e.isDirectory());
      return Promise.all(projects.map(async p => (await markdownFiles(path.join(dir, 'Projects', p.name))).length));
    };
    expect((await shape('demo_vault_en')).sort()).toEqual((await shape('demo_vault')).sort());
  });

  it('the launcher picks the demo vault that matches the notes language', async () => {
    const { demoVaultPath } = await import('../src/vault/demo');
    expect(demoVaultPath({}, '/repo')).toBe(path.resolve('/repo/demo_vault'));
    expect(demoVaultPath({ LANGUAGE: 'en' }, '/repo')).toBe(path.resolve('/repo/demo_vault_en'));
    expect(demoVaultPath({ LANGUAGE: 'en', NOTES_LANGUAGE: 'es' }, '/repo')).toBe(path.resolve('/repo/demo_vault'));
  });
});
