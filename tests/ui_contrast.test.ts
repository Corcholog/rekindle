import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

// WCAG AA contrast (4.5:1) for every text token on every background token, in both themes,
// read from the design tokens in web/src/styles.css.

const css = fs.readFileSync('web/src/styles.css', 'utf-8');
const block = (selector: string) => {
  const body = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))![1];
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
};

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('theme contrast', () => {
  for (const [name, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    it(`${name}: text tokens reach 4.5:1 on every background`, () => {
      const t = block(selector);
      for (const fg of ['ink', 'ink-2', 'ink-3', 'ember', 'ok', 'danger']) {
        for (const bg of ['bg', 'surface', 'surface-2']) {
          expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(t['ember-ink'], t.ember), 'primary button').toBeGreaterThanOrEqual(4.5);
      // The Integrate button is a gradient from ember to ember-2: both ends must hold
      expect(contrast(t['ember-ink'], t['ember-2']), 'integrate button, light end').toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: verdict colours read on their badges and on cards`, () => {
      const t = block(selector);
      for (const [fg, soft] of [['act', 'act-soft'], ['tent', 'tent-soft'], ['ok', 'ok-soft']]) {
        expect(contrast(t[fg], t[soft]), `${fg} on ${soft}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t[fg], t.surface), `${fg} on surface`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: every project colour reads, and its stripe stands out from the card`, () => {
      const t = block(selector);
      for (let i = 0; i < 8; i++) {
        const [ink, soft, stripe] = [t[`p${i}-ink`], t[`p${i}-soft`], t[`p${i}`]];
        expect(ink && soft && stripe, `p${i} tokens`).toBeTruthy();
        // The project's name is written in its ink on the card header (soft) and on plain surfaces
        expect(contrast(ink, soft), `p${i}-ink on its header`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(ink, t.surface), `p${i}-ink on surface`).toBeGreaterThanOrEqual(4.5);
        // The header also holds the date and badges in secondary ink
        expect(contrast(t['ink-2'], soft), `ink-2 on p${i}-soft`).toBeGreaterThanOrEqual(4.5);
        // Stripes and swatches are graphics: WCAG 1.4.11 asks 3:1 against what is next to them
        expect(contrast(stripe, t.surface), `p${i} stripe on surface`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
