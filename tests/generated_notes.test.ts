import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Audit F-03 and invariant I4: notes Loom generates must never overwrite user files,
// must stay inside the vault, and must not feed back into project hashes or snapshots.
describe('generated vault notes', () => {
  let vault: string;
  let projectDir: string;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-generated-'));
    projectDir = path.join(vault, 'Projects', 'Novela');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'ideas.md'), '# Ideas\nTexto del usuario.');
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  it('never overwrites an existing file', async () => {
    const { writeGeneratedNote } = await import('../src/vault/generatedNotes');
    await fs.writeFile(path.join(projectDir, 'research_brief.md'), 'edición manual del usuario');

    const rel = await writeGeneratedNote(projectDir, vault, 'research_brief', 'nuevo contenido');
    expect(rel).not.toBe('Projects/Novela/research_brief.md');
    expect(rel.startsWith('Projects/Novela/research_brief-')).toBe(true);
    expect(await fs.readFile(path.join(projectDir, 'research_brief.md'), 'utf-8')).toBe('edición manual del usuario');
    expect(await fs.readFile(path.join(vault, rel), 'utf-8')).toBe('nuevo contenido');
  });

  it('refuses to write outside the vault', async () => {
    const { writeGeneratedNote } = await import('../src/vault/generatedNotes');
    await expect(writeGeneratedNote(path.join(vault, '..'), vault, 'escape', 'x')).rejects.toThrow(/outside the vault/);
  });

  it('marks notes as generated and keeps them out of the project hash', async () => {
    const { writeGeneratedNote, formatResearchBrief, isGeneratedNote } = await import('../src/vault/generatedNotes');
    const { getDirectoryHash } = await import('../src/vault/hash');

    const before = await getDirectoryHash(projectDir);
    const rel = await writeGeneratedNote(projectDir, vault, 'research_brief', formatResearchBrief({
      title: 'Brief "con comillas"',
      executiveSummary: 'Resumen',
      markdownContent: '## Cuerpo',
      suggestedNextSteps: ['Paso 1'],
    }, 2));

    expect(await isGeneratedNote(path.join(vault, rel))).toBe(true);
    expect(await isGeneratedNote(path.join(projectDir, 'ideas.md'))).toBe(false);
    expect(await getDirectoryHash(projectDir)).toBe(before);
  });

  it('treats briefs and bridges written by earlier versions as generated', async () => {
    const { isGeneratedNote } = await import('../src/vault/generatedNotes');
    const legacy = path.join(projectDir, 'old_brief.md');
    await fs.writeFile(legacy, '---\ntitle: "x"\ntype: research_brief\n---\n# x\n');
    expect(await isGeneratedNote(legacy)).toBe(true);
    // Notes written before the rename to Rekindle
    const loomNote = path.join(projectDir, 'old_note.md');
    await fs.writeFile(loomNote, '---\ntitle: "y"\nloom_generated: true\n---\n# y\n');
    expect(await isGeneratedNote(loomNote)).toBe(true);
    const { getDirectoryHash } = await import('../src/vault/hash');
    const before = await getDirectoryHash(projectDir);
    await fs.writeFile(path.join(projectDir, 'another_old_note.md'), '---\nloom_generated: true\n---\n# z\n');
    expect(await getDirectoryHash(projectDir)).toBe(before);
  });

  it('escapes YAML and sanitizes model text in the note body', async () => {
    const { formatSynergyNote } = await import('../src/vault/generatedNotes');
    const note = formatSynergyNote({
      bridgeTitle: 'Puente"\ninjected: true',
      overview: 'Visión ![[secreto]]',
      sharedProblems: ['<script>x</script>'],
      mutualBenefits: ['ok'],
      markdownContent: '```dataviewjs\ndv.paragraph(1)\n```',
    }, 'Proyecto "A"', 'Proyecto B');

    const frontmatter = note.split('\n---\n')[0];
    expect(frontmatter).not.toMatch(/^injected:/m);
    expect(frontmatter).toContain('rekindle_generated: true');
    expect(note).not.toContain('![[');
    expect(note).not.toContain('<script>');
    expect(note).not.toMatch(/(^|[^\\])```/);
  });
});
