import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DICT } from '../web/src/i18n/dict';

// The web UI's dictionaries (web/src/i18n/dict.ts): both languages have the same keys, every key
// the components use exists, every API error code has a label, and no component renders strings
// as HTML (React escapes everything else; this is the T9 boundary).

async function sources(dir: string): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(full));
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push({ file: full, text: await fs.readFile(full, 'utf-8') });
  }
  return out;
}

const SAMPLE = { n: 2, actionable: 1, tentative: 1, library: 2, notes: 3, project: 'P', path: 'p.md', ref: 'C1', dir: 'Projects', active: 2, missing: 1, message: 'm' };

describe('web UI dictionaries', () => {
  it('have the same keys in Spanish and English, and no empty value', () => {
    expect(Object.keys(DICT.en).sort()).toEqual(Object.keys(DICT.es).sort());
    for (const lang of ['es', 'en'] as const) {
      for (const [key, value] of Object.entries(DICT[lang])) {
        const text = typeof value === 'function' ? (value as (p: typeof SAMPLE) => string)(SAMPLE) : value;
        expect(typeof text === 'string' && text.trim().length > 0, `${lang} ${key}`).toBe(true);
      }
    }
  });

  it('define every key the components use', async () => {
    const files = await sources('web/src');
    const used = new Set<string>();
    for (const { text } of files) {
      for (const m of text.matchAll(/\bt(?:Rich)?\('([\w.]+)'/g)) used.add(m[1]);
      for (const m of text.matchAll(/apiError\([^,]+, '([\w.]+)'\)/g)) used.add(m[1]);
      for (const m of text.matchAll(/label: '([\w.]+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(150);
    expect([...used].filter(key => !(key in DICT.es))).toEqual([]);
    // Keys built at run time
    for (const prefix of ['action.', 'ingestStatus.', 'verdict.', 'reason.', 'theme.', 'lang.']) {
      expect(Object.keys(DICT.es).some(k => k.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it('label every error code the API sends', async () => {
    const api = (await Promise.all(['ingest', 'library', 'projects', 'settings', 'suggestions'].map(f => fs.readFile(`src/api/routes/${f}.ts`, 'utf-8')))).join('\n')
      + await fs.readFile('src/api/server.ts', 'utf-8');
    const codes = [...new Set([...api.matchAll(/code: '(\w+)'/g)].map(m => m[1]))];
    expect(codes.length).toBeGreaterThan(5);
    for (const code of codes) expect((DICT.en as Record<string, unknown>)[`error.${code}`], code).toBeTruthy();
  });

  it('never render a string as HTML', async () => {
    const offenders = (await sources('web/src')).filter(f => /dangerouslySetInnerHTML|\.innerHTML\s*=/.test(f.text)).map(f => f.file);
    expect(offenders).toEqual([]);
  });

  it('offer the stored discard reasons, each labeled in both languages', async () => {
    const { DISCARD_REASONS } = await import('../src/db/schema');
    const card = await fs.readFile('web/src/components/SuggestionCard.tsx', 'utf-8');
    const offered = [...card.match(/DISCARD_REASONS: DiscardReason\[\] = \[([^\]]*)\]/)![1].matchAll(/'(\w+)'/g)].map(m => m[1]);
    expect(offered).toEqual([...DISCARD_REASONS]);
    for (const reason of DISCARD_REASONS) {
      expect((DICT.es as Record<string, unknown>)[`reason.${reason}`]).toBeTruthy();
      expect((DICT.en as Record<string, unknown>)[`reason.${reason}`]).toBeTruthy();
    }
  });
});
