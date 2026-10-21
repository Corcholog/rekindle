import { describe, it, expect, vi } from 'vitest';

// The accepted callout links to the note the suggestion is for. The note name came from a model,
// so anything that would break Obsidian's link syntax or leave the project gets no link.
describe('suggested note link in accepted callouts', () => {
  vi.stubEnv('DATABASE_URL', 'postgres://user:pass@127.0.0.1:9/none');

  it('links to the note by its path inside the vault, showing only its name', async () => {
    const { suggestedNoteLink } = await import('../src/vault/updater');
    expect(suggestedNoteLink('ideas.md', 'Projects/Faro')).toBe('[[Projects/Faro/ideas|ideas]]');
    expect(suggestedNoteLink('research/combat.md', 'Projects/Faro/')).toBe('[[Projects/Faro/research/combat|combat]]');
    expect(suggestedNoteLink('posibles incorporaciones.md', 'Projects/Sobrecarga')).toBe('[[Projects/Sobrecarga/posibles incorporaciones|posibles incorporaciones]]');
  });

  it('gives no link for placeholders or names that would break the syntax or leave the project', async () => {
    const { suggestedNoteLink } = await import('../src/vault/updater');
    for (const bad of [null, '', 'tentative', 'discarded', 'unknown', 'suggestions.md', 'a]]b.md', 'x|y.md', 'n#h.md', '../fuera.md', '/abs.md', 'a\nb.md']) {
      expect(suggestedNoteLink(bad, 'Projects/Faro'), String(bad)).toBeNull();
    }
  });

  it('adds the line to the callout only when there is a note, in the output language', async () => {
    const { formatAcceptedCallout } = await import('../src/vault/updater');
    const base = { id: 'x', actionType: 'evidence_citation', observation: 'o', suggestedAction: 'a', userFeedback: null, sourceUri: null, sourceTitle: null };
    expect(formatAcceptedCallout({ ...base, targetFile: 'ideas.md', folderPath: 'Projects/Faro' }, new Date(), 'en')).toContain('> **Suggested note:** [[Projects/Faro/ideas|ideas]]');
    expect(formatAcceptedCallout({ ...base, targetFile: 'tentative', folderPath: 'Projects/Faro' }, new Date(), 'en')).not.toContain('Suggested note');
  });

  it('labels a proposed new note, whose link creates it in Obsidian when clicked', async () => {
    const { formatAcceptedCallout } = await import('../src/vault/updater');
    const base = { id: 'x', actionType: 'evidence_citation', observation: 'o', suggestedAction: 'a', userFeedback: null, sourceUri: null, sourceTitle: null };
    const sug = { ...base, targetFile: 'research/contraargumentos.md', targetIsNew: true, folderPath: 'Projects/Faro' };
    expect(formatAcceptedCallout(sug, new Date(), 'es')).toContain('> **Nota nueva sugerida:** [[Projects/Faro/research/contraargumentos|contraargumentos]]');
    expect(formatAcceptedCallout(sug, new Date(), 'en')).toContain('> **Suggested new note:** [[Projects/Faro/research/contraargumentos|contraargumentos]]');
    expect(formatAcceptedCallout({ ...sug, targetIsNew: false }, new Date(), 'es')).toContain('> **Nota sugerida:**');
  });
});
