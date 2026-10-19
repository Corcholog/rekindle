import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// The dataset loader, label-sheet generator and validator. The agent builds tooling; the owner
// supplies the ground truth, so generated sheets must start with every verdict empty.
describe('eval dataset tooling', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-evalset-'));
    await fs.mkdir(path.join(dir, 'vault', 'Projects', 'Anime', 'sub'), { recursive: true });
    await fs.mkdir(path.join(dir, 'vault', 'Projects', 'Cocina'), { recursive: true });
    await fs.mkdir(path.join(dir, 'articles'), { recursive: true });
    await fs.writeFile(path.join(dir, 'vault', 'Projects', 'Anime', 'ideas.md'), '# Ideas\nLa muerte en el anime');
    await fs.writeFile(path.join(dir, 'vault', 'Projects', 'Anime', 'sub', 'tema.md'), '# Tema');
    await fs.writeFile(path.join(dir, 'vault', 'Projects', 'Cocina', 'recetas.md'), '# Recetas');
    await fs.writeFile(path.join(dir, 'articles', 'muerte-anime.json'), JSON.stringify({
      id: 'muerte-anime', title: 'La muerte en el anime', source: 'synthetic', text: 'Texto del artículo.',
    }));
    await fs.writeFile(path.join(dir, 'articles', 'pan.json'), JSON.stringify({
      id: 'pan', title: 'Pan de masa madre', source: 'synthetic', text: 'Receta.',
    }));
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('loads projects, notes and articles', async () => {
    const { loadDataset } = await import('../evals/runner/dataset');
    const dataset = await loadDataset(dir);

    expect(dataset.projects.map(p => p.folderPath)).toEqual(['Projects/Anime', 'Projects/Cocina']);
    expect(dataset.projects[0].notes).toEqual(['ideas.md', 'sub/tema.md']);
    expect(dataset.articles.map(a => a.id)).toEqual(['muerte-anime', 'pan']);
    expect(dataset.labels).toBeNull();
    expect(dataset.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the manifest hash when any input changes', async () => {
    const { loadDataset } = await import('../evals/runner/dataset');
    const before = (await loadDataset(dir)).manifestHash;
    await fs.appendFile(path.join(dir, 'vault', 'Projects', 'Cocina', 'recetas.md'), '\nmás');
    expect((await loadDataset(dir)).manifestHash).not.toBe(before);
  });

  it('generates a label sheet with every verdict empty and keeps existing answers', async () => {
    const { loadDataset, generateLabelSheet } = await import('../evals/runner/dataset');
    await generateLabelSheet(dir);

    let labels = (await loadDataset(dir)).labels!;
    expect(labels.labeled_by).toBeNull();
    expect(labels.cases.map(c => c.article)).toEqual(['muerte-anime', 'pan']);
    for (const c of labels.cases) {
      expect(Object.keys(c.projects)).toEqual(['Projects/Anime', 'Projects/Cocina']);
      for (const p of Object.values(c.projects)) expect(p.verdict).toBeNull();
    }

    // The owner answers one pair; regenerating after a new article must not touch it
    labels.cases[0].projects['Projects/Anime'].verdict = 'actionable';
    const { default: YAML } = await import('yaml');
    await fs.writeFile(path.join(dir, 'labels.yaml'), YAML.stringify(labels));
    await fs.writeFile(path.join(dir, 'articles', 'nuevo.json'), JSON.stringify({
      id: 'nuevo', title: 'Nuevo', source: 'synthetic', text: 'x',
    }));
    await generateLabelSheet(dir);

    labels = (await loadDataset(dir)).labels!;
    expect(labels.cases.map(c => c.article)).toEqual(['muerte-anime', 'pan', 'nuevo']);
    expect(labels.cases[0].projects['Projects/Anime'].verdict).toBe('actionable');
    expect(labels.cases[2].projects['Projects/Anime'].verdict).toBeNull();
  });

  it('validates labels against the dataset', async () => {
    const { loadDataset, validateLabels } = await import('../evals/runner/dataset');
    const { default: YAML } = await import('yaml');
    await fs.writeFile(path.join(dir, 'labels.yaml'), YAML.stringify({
      labeled_by: 'owner',
      cases: [
        { article: 'muerte-anime', projects: {
          'Projects/Anime': { verdict: 'actionable', target_note: 'tema.md' },
          'Projects/Fantasma': { verdict: 'irrelevant' },
        } },
        { article: 'no-existe', projects: {} },
        { article: 'pan', projects: { 'Projects/Cocina': { verdict: 'actionable', target_note: 'inexistente.md' } } },
      ],
    }));
    const errors = validateLabels(await loadDataset(dir), { strict: false });

    expect(errors.some(e => /Projects\/Fantasma/.test(e))).toBe(true);
    expect(errors.some(e => /no-existe/.test(e))).toBe(true);
    expect(errors.some(e => /inexistente\.md/.test(e))).toBe(true);
    expect(errors.some(e => /tema\.md/.test(e))).toBe(false); // resolves to sub/tema.md
  });

  it('applies the case-level "others" shortcut to blank projects only', async () => {
    const { loadDataset, validateLabels, effectiveVerdict } = await import('../evals/runner/dataset');
    const { default: YAML } = await import('yaml');
    await fs.writeFile(path.join(dir, 'labels.yaml'), YAML.stringify({
      labeled_by: 'owner',
      cases: [
        { article: 'muerte-anime', others: 'irrelevant', projects: { 'Projects/Anime': { verdict: 'actionable', target_note: 'ideas.md' } } },
        { article: 'pan', others: 'irrelevant', projects: {} },
      ],
    }));
    const dataset = await loadDataset(dir);
    const [anime, pan] = dataset.labels!.cases;

    expect(effectiveVerdict(anime, 'Projects/Anime')).toBe('actionable');
    expect(effectiveVerdict(anime, 'Projects/Cocina')).toBe('irrelevant');
    expect(effectiveVerdict(pan, 'Projects/Anime')).toBe('irrelevant');
    expect(validateLabels(dataset, { strict: true })).toEqual([]);

    // Without the shortcut a blank project stays unanswered
    delete (anime as any).others;
    expect(effectiveVerdict(anime, 'Projects/Cocina')).toBeNull();
  });

  it('strict mode requires a labeler and every verdict', async () => {
    const { loadDataset, generateLabelSheet, validateLabels } = await import('../evals/runner/dataset');
    await generateLabelSheet(dir);
    const errors = validateLabels(await loadDataset(dir), { strict: true });
    expect(errors.some(e => /labeled_by/.test(e))).toBe(true);
    expect(errors.filter(e => /sin veredicto/.test(e))).toHaveLength(4); // 2 articles x 2 projects
  });
});
