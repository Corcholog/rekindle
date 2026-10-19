import { createContext, useContext } from 'react';

// Each project gets one of 8 colours (the --p0…--p7 tokens). Views that only know a project's
// title (Reading, Consultant) get the same colour as the Suggestions sidebar.
export const HUE_COUNT = 8;

/** A well-mixed 32-bit hash (FNV-1a with a final avalanche), so similar titles spread out. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export const hueOf = (title: string) => hash(title) % HUE_COUNT;

/**
 * Colours for a set of projects: each takes its hashed colour, or the next free one when another
 * project already has it, so up to 8 projects never share a colour. Titles are taken in sorted
 * order, so the result does not depend on how the list was fetched.
 */
export function assignHues(titles: string[]): Map<string, number> {
  const hues = new Map<string, number>();
  const taken = new Set<number>();
  for (const title of [...new Set(titles)].sort()) {
    let hue = hueOf(title);
    for (let i = 0; i < HUE_COUNT && taken.has(hue); i++) hue = (hue + 1) % HUE_COUNT;
    taken.add(hue);
    hues.set(title, hue);
  }
  return hues;
}

export const ProjectHuesContext = createContext<Map<string, number>>(new Map());

/** The colour index of a project, by title; unknown titles fall back to their hash. */
export function useProjectHue(title: string | null | undefined): number {
  const hues = useContext(ProjectHuesContext);
  if (!title) return 0;
  return hues.get(title) ?? hueOf(title);
}
