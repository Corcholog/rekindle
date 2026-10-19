import { describe, it, expect } from 'vitest';

// Audit F-04: model text (derived from untrusted web pages) must not be able to inject
// active or misleading markdown into the vault.
describe('sanitizeForVault', () => {
  const cases: [string, string, (out: string) => void][] = [
    ['code fences', 'ok\n```dataviewjs\ndv.paragraph("x")\n```', out => expect(out).not.toMatch(/(^|[^\\])```/)],
    ['tilde fences', '~~~js\nalert(1)\n~~~', out => expect(out).not.toMatch(/(^|[^\\])~~~/)],
    ['wiki embeds', 'see ![[Private Diary]]', out => expect(out).not.toContain('![[')],
    ['image embeds (tracking pixels)', '![x](https://evil.example/pixel.png)', out => expect(out).not.toMatch(/!\[x\]\(/)],
    ['raw HTML', '<iframe src="https://evil.example"></iframe><script>x</script>', out => expect(out).not.toMatch(/<(iframe|script)/i)],
    ['Templater tags', '<% tp.system.exec("rm -rf ~") %>', out => expect(out).not.toContain('<%')],
    ['Obsidian comments', 'hidden %% secret %%', out => expect(out).not.toMatch(/(^|[^\\])%%/)],
    ['forged callouts', 'text\n> [!danger] Fake warning', out => {
      expect(out).not.toMatch(/^>/m);
      expect(out).not.toMatch(/(^|[^\\])\[!/);
    }],
    ['Dataview inline queries', 'value `= this.file.name` and `$= dv.current()`', out => expect(out).not.toMatch(/(^|[^\\])`\$?=/)],
    ['control characters', 'a\u0000b\u001bc', out => expect(out).toBe('abc')],
  ];

  for (const [name, input, check] of cases) {
    it(`neutralizes ${name}`, async () => {
      const { sanitizeForVault } = await import('../src/vault/sanitize');
      check(sanitizeForVault(input));
    });
  }

  it('keeps plain text, links and wikilinks readable', async () => {
    const { sanitizeForVault } = await import('../src/vault/sanitize');
    const text = 'Citar en [[Acto 2]] la fuente [paper](https://example.com/p) — 3 > 2';
    expect(sanitizeForVault(text)).toBe(text);
  });

  it('caps the length', async () => {
    const { sanitizeForVault } = await import('../src/vault/sanitize');
    const out = sanitizeForVault('x'.repeat(10000), 100);
    expect(out.length).toBeLessThanOrEqual(101);
  });
});

describe('formatAcceptedCallout', () => {
  it('keeps every line inside the callout and neutralizes injected markdown', async () => {
    const { formatAcceptedCallout } = await import('../src/vault/updater');
    const callout = formatAcceptedCallout({
      id: '11111111-1111-1111-1111-111111111111',
      actionType: 'evidence_citation',
      suggestedAction: 'Citar esto.\n```dataviewjs\ndv.paragraph(1)\n```\n> [!danger] Falso',
      observation: 'Obs ![[secreto]]',
      userFeedback: null,
      sourceUri: 'https://example.com/a(b)',
      sourceTitle: 'Título [raro]',
    });

    const lines = callout.trim().split('\n');
    for (const line of lines) expect(line.startsWith('>')).toBe(true);
    expect(callout).not.toMatch(/(^|[^\\])```/);
    expect(callout).not.toContain('![[');
    expect(callout.match(/(^|[^\\])\[!/g)?.length).toBe(1); // only Loom's own [!tip]
  });

  it('drops non-http source links', async () => {
    const { formatAcceptedCallout } = await import('../src/vault/updater');
    const callout = formatAcceptedCallout({
      id: '22222222-2222-2222-2222-222222222222',
      actionType: 'other',
      suggestedAction: 'a',
      observation: 'b',
      userFeedback: null,
      sourceUri: 'javascript:alert(1)',
      sourceTitle: 'x',
    });
    expect(callout).not.toContain('javascript:');
  });
});

describe('callout date', () => {
  it('is dd/mm/yyyy whatever the machine locale', async () => {
    const { formatCalloutDate, formatAcceptedCallout } = await import('../src/vault/updater');
    expect(formatCalloutDate(new Date(2026, 9, 18))).toBe('18/10/2026');
    expect(formatCalloutDate(new Date(2026, 0, 5))).toBe('05/01/2026');
    const callout = formatAcceptedCallout({
      id: '22222222-2222-2222-2222-222222222222', actionType: 'other', suggestedAction: 'a', observation: 'o',
      userFeedback: null, sourceUri: null, sourceTitle: null,
    }, new Date(2026, 9, 18));
    expect(callout).toContain('OTRO (18/10/2026)');
  });
});
