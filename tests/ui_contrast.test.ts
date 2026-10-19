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
      expect(contrast(t.surface, t.ok), 'accept button').toBeGreaterThanOrEqual(4.5);
    });
  }
});
