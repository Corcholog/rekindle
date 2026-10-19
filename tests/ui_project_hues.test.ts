import { describe, it, expect } from 'vitest';
import { assignHues, hueOf, HUE_COUNT } from '../web/src/lib/projectHues';

// Project colours must not collide while there are colours left, and every view must agree.
describe('project colours', () => {
  it('gives up to 8 projects distinct colours, whatever order they arrive in', () => {
    const titles = Array.from({ length: HUE_COUNT }, (_, i) => `Project ${i}`);
    const hues = assignHues(titles);
    expect(new Set(hues.values()).size).toBe(HUE_COUNT);
    expect(assignHues([...titles].reverse())).toEqual(hues);
  });

  it('keeps the demo projects apart in both languages', () => {
    for (const titles of [
      ['Atención y redes sociales', 'El faro del fin del mundo', 'Mareas: juego de mesa', 'Ciudades invisibles: podcast'],
      ['Attention and social media', 'Invisible Cities: a podcast', 'The Lighthouse at the End of the World', 'Tides: a board game'],
    ]) {
      expect(new Set(assignHues(titles).values()).size).toBe(4);
    }
  });

  it('falls back to the hashed colour for a ninth project and for unknown titles', () => {
    const titles = Array.from({ length: HUE_COUNT + 1 }, (_, i) => `Project ${i}`);
    const hues = assignHues(titles);
    for (const hue of hues.values()) expect(hue).toBeGreaterThanOrEqual(0);
    expect(hueOf('Anything')).toBe(hueOf('Anything'));
    expect(hueOf('Anything')).toBeLessThan(HUE_COUNT);
  });
});
