import { describe, it, expect } from 'vitest';
import { buildNotesContext, ContextNote } from '../src/evaluator/notesContext';

const note = (path: string, text: string, distance?: number): ContextNote => ({ path, title: path.replace(/\.md$/, ''), text, distance });

describe('notes context', () => {
  it('sends every note whole, in path order, when the project fits the budget', () => {
    const notes = [note('z-final.md', 'Texto Z'), note('research/fuentes.md', 'Texto F'), note('borrador.md', 'Texto B')];
    const ctx = buildNotesContext(notes, 1000, 'es');
    expect(ctx).toMatchObject({ included: 3, omitted: 0 });
    expect(ctx.text).toContain('ÍNDICE DE NOTAS');
    expect(ctx.text.indexOf('### borrador.md')).toBeLessThan(ctx.text.indexOf('### research/fuentes.md'));
    expect(ctx.text.indexOf('### research/fuentes.md')).toBeLessThan(ctx.text.indexOf('### z-final.md'));
    expect(ctx.text).not.toContain('texto no incluido');
  });

  it('is the same for every article when it fits, whatever the distances', () => {
    const a = [note('a.md', 'A', 0.2), note('b.md', 'B', 0.5)];
    const b = [note('a.md', 'A', 0.6), note('b.md', 'B', 0.1)];
    expect(buildNotesContext(a, 100, 'es').text).toBe(buildNotesContext(b, 100, 'es').text);
  });

  it('fills the budget with the notes closest to the article and still lists every path', () => {
    const notes = [
      note('a-lejana.md', 'L'.repeat(3000), 0.55),
      note('b-cercana.md', 'C'.repeat(3000), 0.30),
      note('c-media.md', 'M'.repeat(3000), 0.40),
      note('d-sin-vector.md', 'S'.repeat(3000), null),
    ];
    const ctx = buildNotesContext(notes, 6500, 'es');
    // The two closest go in whole; 500 characters left is too little for a piece of the third
    expect(ctx).toMatchObject({ included: 2, omitted: 2 });
    expect(ctx.text).toContain(`### b-cercana.md — "b-cercana"\n${'C'.repeat(3000)}`);
    expect(ctx.text).toContain(`### c-media.md — "c-media"\n${'M'.repeat(3000)}`);
    expect(ctx.text).not.toContain('### a-lejana.md');
    expect(ctx.text).toContain('- a-lejana.md — "a-lejana" (texto no incluido)');
    expect(ctx.text).toContain('- d-sin-vector.md — "d-sin-vector" (texto no incluido)');
    expect(ctx.text.indexOf('### b-cercana.md')).toBeLessThan(ctx.text.indexOf('### c-media.md'));
  });

  it('cuts the next note when enough budget is left for a useful piece', () => {
    const notes = [note('a.md', 'A'.repeat(5000), 0.2), note('b.md', 'B'.repeat(5000), 0.3)];
    const ctx = buildNotesContext(notes, 7000, 'es');
    expect(ctx).toMatchObject({ included: 2, omitted: 0 });
    expect(ctx.text).toContain(`${'B'.repeat(2000)} […]`);
    expect(ctx.text).not.toContain('B'.repeat(2001));
  });

  it('sends a long note past the old 4,000-character cut', () => {
    const long = `${'x'.repeat(9000)}FINAL`;
    expect(buildNotesContext([note('largo.md', long)], 60_000, 'es').text).toContain('FINAL');
  });

  it('labels the index in English', () => {
    const ctx = buildNotesContext([note('a.md', 'A'.repeat(10), 0.1), note('b.md', 'B'.repeat(5000), 0.2)], 100, 'en');
    expect(ctx.text).toContain('NOTE INDEX (paths relative to the project):');
    expect(ctx.text).toContain('- b.md — "b" (text not included)');
  });
});
