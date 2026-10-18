import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import YAML from 'yaml';
import { Article, ArticleSchema, Labels, LabelsSchema } from '../schema';
import { noteMatches, Verdict } from './metrics';

/**
 * A dataset directory:
 *   vault/Projects/<Name>/**.md   the projects as Obsidian holds them
 *   articles/<id>.json            article text and metadata
 *   labels.yaml                   the owner's ground truth (generated empty, filled in by hand)
 *   cache/                        embeddings, summaries and recorded LLM responses
 */
export interface DatasetProject {
  /** Vault-relative folder, e.g. "Projects/Anime". */
  folderPath: string;
  /** Note paths relative to the project folder, "suggestions.md" excluded. */
  notes: string[];
}

export interface Dataset {
  dir: string;
  vaultPath: string;
  projects: DatasetProject[];
  articles: Article[];
  labels: Labels | null;
  manifestHash: string;
}

const PROJECT_ROOTS = ['Projects', 'Proyectos'];

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

export async function loadDataset(dir: string): Promise<Dataset> {
  const vaultPath = path.join(dir, 'vault');
  const projects: DatasetProject[] = [];
  for (const root of PROJECT_ROOTS) {
    const names = (await fs.readdir(path.join(vaultPath, root), { withFileTypes: true }).catch(() => []))
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const files = await listFiles(path.join(vaultPath, root, name));
      projects.push({
        folderPath: `${root}/${name}`,
        notes: files.filter(f => f.toLowerCase().endsWith('.md') && path.basename(f).toLowerCase() !== 'suggestions.md'),
      });
    }
  }

  const articleFiles = (await listFiles(path.join(dir, 'articles'))).filter(f => f.endsWith('.json'));
  const articles: Article[] = [];
  for (const file of articleFiles) {
    articles.push(ArticleSchema.parse(JSON.parse(await fs.readFile(path.join(dir, 'articles', file), 'utf-8'))));
  }

  let labels: Labels | null = null;
  const labelsRaw = await fs.readFile(path.join(dir, 'labels.yaml'), 'utf-8').catch(() => null);
  if (labelsRaw !== null) labels = LabelsSchema.parse(YAML.parse(labelsRaw) ?? { labeled_by: null, cases: [] });

  const hash = crypto.createHash('sha256');
  for (const file of await listFiles(vaultPath)) {
    hash.update(`vault/${file}\0`).update(await fs.readFile(path.join(vaultPath, file)));
  }
  for (const file of articleFiles) {
    hash.update(`articles/${file}\0`).update(await fs.readFile(path.join(dir, 'articles', file)));
  }
  if (labelsRaw !== null) hash.update('labels.yaml\0').update(labelsRaw);

  return { dir, vaultPath, projects, articles, labels, manifestHash: hash.digest('hex') };
}

/** The labeler's verdict for a pair: the explicit one, else the case-level `others` shortcut. */
export function effectiveVerdict(labelCase: Labels['cases'][number], projectPath: string): Verdict | null {
  return labelCase.projects[projectPath]?.verdict ?? labelCase.others ?? null;
}

const SHEET_HEADER = `# Etiquetas de evaluación — las rellena el dueño del proyecto.
#
# Para cada artículo y cada proyecto, indica el veredicto correcto:
#   actionable  el artículo aporta algo concreto que se puede usar en ese proyecto
#   tentative   tiene relación temática, pero sin una aportación clara
#   irrelevant  no tiene que ver con el proyecto
# Si el veredicto es actionable, rellena target_note con la nota donde lo integrarías
# (ruta dentro del proyecto o nombre de archivo, p. ej. "research/combate.md").
# Atajo: pon en "others" un veredicto (normalmente irrelevant) y se aplicará a todos los proyectos
# que dejes en blanco; así solo marcas los proyectos que sí tienen relación.
# Pon tu nombre en labeled_by al terminar. Valida con: pnpm eval:label --check <dataset>
`;

/** Adds an empty entry for every article without one; existing answers are never modified. */
export async function generateLabelSheet(dir: string): Promise<void> {
  const dataset = await loadDataset(dir);
  const labels: Labels = dataset.labels ?? { labeled_by: null, cases: [] };

  for (const article of dataset.articles) {
    if (labels.cases.some(c => c.article === article.id)) continue;
    labels.cases.push({
      article: article.id,
      others: null,
      projects: Object.fromEntries(dataset.projects.map(p => [p.folderPath, { verdict: null, target_note: null }])),
      notes: null,
    });
  }
  // Projects added later also need an entry in existing cases
  for (const c of labels.cases) {
    for (const p of dataset.projects) {
      if (!(p.folderPath in c.projects)) c.projects[p.folderPath] = { verdict: null, target_note: null };
    }
  }

  await fs.writeFile(path.join(dir, 'labels.yaml'), SHEET_HEADER + YAML.stringify(labels), 'utf-8');
}

export function validateLabels(dataset: Dataset, options: { strict: boolean }): string[] {
  const errors: string[] = [];
  const labels = dataset.labels;
  if (!labels) return ['No existe labels.yaml: genera la hoja con pnpm eval:label <dataset>'];

  if (options.strict && !labels.labeled_by) errors.push('labeled_by está vacío: indica quién etiquetó');

  const articleIds = new Set(dataset.articles.map(a => a.id));
  const projectsByPath = new Map(dataset.projects.map(p => [p.folderPath, p]));

  for (const c of labels.cases) {
    if (!articleIds.has(c.article)) errors.push(`Caso "${c.article}": no existe ese artículo en articles/`);
    for (const [projectPath, label] of Object.entries(c.projects)) {
      const project = projectsByPath.get(projectPath);
      if (!project) {
        errors.push(`Caso "${c.article}": el proyecto "${projectPath}" no existe en el vault del dataset`);
        continue;
      }
      if (options.strict && effectiveVerdict(c, projectPath) === null) {
        errors.push(`Caso "${c.article}" × "${projectPath}": sin veredicto`);
      }
      if (label.target_note && !project.notes.some(n => noteMatches(label.target_note!, n))) {
        errors.push(`Caso "${c.article}" × "${projectPath}": la nota "${label.target_note}" no existe en el proyecto`);
      }
      if (label.target_note && effectiveVerdict(c, projectPath) !== 'actionable') {
        errors.push(`Caso "${c.article}" × "${projectPath}": target_note solo aplica si el veredicto es actionable`);
      }
    }
  }
  if (options.strict) {
    for (const id of articleIds) {
      if (!labels.cases.some(c => c.article === id)) errors.push(`Artículo "${id}": sin etiquetas`);
    }
  }
  return errors;
}
