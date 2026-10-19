import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs/promises';

// The web UI's dictionaries (web/i18n.js): both languages have the same keys, every key the
// page and app.js use exists, and the static page renders fully in English.

describe('web UI dictionaries', () => {
  let i18n: any;
  let html: string;
  let appJs: string;

  beforeAll(async () => {
    html = await fs.readFile('web/index.html', 'utf-8');
    appJs = await fs.readFile('web/app.js', 'utf-8');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://127.0.0.1:3000/' });
    dom.window.eval(await fs.readFile('web/i18n.js', 'utf-8'));
    i18n = (dom.window as any).LoomI18n;
  });

  it('has the same keys in Spanish and English, and no empty value', () => {
    const es = Object.keys(i18n.DICT.es).sort();
    const en = Object.keys(i18n.DICT.en).sort();
    expect(en).toEqual(es);
    for (const lang of ['es', 'en']) {
      for (const [key, value] of Object.entries(i18n.DICT[lang])) {
        const text = typeof value === 'function' ? (value as any)({ n: 2, actionable: 1, tentative: 1, library: 2, notes: 3, project: 'P', path: 'p.md', ref: 'C1', dir: 'Projects', active: 2, missing: 1 }) : value;
        expect(typeof text === 'string' && text.trim().length > 0, `${lang} ${key}`).toBe(true);
      }
    }
  });

  it('defines every key the page and app.js use', () => {
    const htmlKeys = [
      ...[...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map(m => m[1]),
      ...[...html.matchAll(/data-i18n-attrs="([^"]+)"/g)].flatMap(m => m[1].split(',').map(pair => pair.split(':')[1].trim())),
    ];
    const jsKeys = [...appJs.matchAll(/\bt\('([\w.]+)'/g), ...appJs.matchAll(/apiError\([^,]+, '([\w.]+)'\)/g)].map(m => m[1]);
    const missing = [...new Set([...htmlKeys, ...jsKeys])].filter(key => !(key in i18n.DICT.es));
    expect(missing).toEqual([]);
    expect(htmlKeys.length).toBeGreaterThan(80);
    expect(jsKeys.length).toBeGreaterThan(100);
  });

  it('labels every error code the API sends', async () => {
    const sources = (await Promise.all(['ingest', 'library', 'projects', 'settings', 'suggestions'].map(f => fs.readFile(`src/api/routes/${f}.ts`, 'utf-8')))).join('\n')
      + await fs.readFile('src/api/server.ts', 'utf-8');
    const codes = [...new Set([...sources.matchAll(/code: '(\w+)'/g)].map(m => m[1]))];
    expect(codes.length).toBeGreaterThan(5);
    for (const code of codes) expect(i18n.DICT.en[`error.${code}`], code).toBeTruthy();
  });

  it('renders the static page in English with no Spanish text left', async () => {
    const dom = new JSDOM(html.replace(/<script[^>]*src="(app|i18n)\.js"[^>]*><\/script>/g, ''), { runScripts: 'outside-only', url: 'http://127.0.0.1:3000/' });
    dom.window.eval(await fs.readFile('web/i18n.js', 'utf-8'));
    const api = (dom.window as any).LoomI18n;
    api.setLanguage('en');
    api.applyStatic();
    const doc = dom.window.document;
    expect(doc.documentElement.lang).toBe('en');
    expect(doc.title).toBe('Loom — Contextual Writing Assistant');
    const text = doc.body.textContent!.replace(/\s+/g, ' ');
    // Words that only appear in the Spanish strings
    for (const word of ['Sugerencias', 'Configuración', 'Guardar', 'Proyectos registrados', 'Cargando', 'Extensión']) {
      expect(text, word).not.toContain(word);
    }
    // The language names are shown in their own language on purpose
    expect(text).toContain('Español');
    const placeholders = [...doc.querySelectorAll('[placeholder]')].map(el => el.getAttribute('placeholder'));
    expect(placeholders.join(' ')).not.toMatch(/[¿áéíóúñ]/);
  });
});
