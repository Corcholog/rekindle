import * as fs from 'fs/promises';
import * as path from 'path';
import { sanitizeForVault, yamlString } from './sanitize';
import { Language, outputLanguage } from '../ai/language';
import { serverText } from '../i18n/serverText';

// rekindle_generated marks notes written by Rekindle. Notes from before the rename carry
// loom_generated, and the earliest versions only their type; all of them stay excluded.
const GENERATED_FRONTMATTER = /^---\r?\n[\s\S]*?^((?:rekindle|loom)_generated:\s*true|type:\s*(research_brief|cross_project_synergy))\s*$/m;
const MAX_BODY_LENGTH = 20000;

/** True if the note was written by Loom; such notes are excluded from hashes and snapshots. */
export async function isGeneratedNote(fullPath: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(fullPath, 'r');
    const buffer = Buffer.alloc(2048);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf-8');
    const frontmatterEnd = head.indexOf('\n---', 3);
    if (!head.startsWith('---') || frontmatterEnd === -1) return false;
    return GENERATED_FRONTMATTER.test(head.slice(0, frontmatterEnd + 4));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function timestampSuffix(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}

/**
 * Writes a new note inside the vault and returns its vault-relative path.
 * Never overwrites: if the name is taken, a timestamped name is used instead.
 */
export async function writeGeneratedNote(targetDir: string, vaultRoot: string, baseName: string, content: string): Promise<string> {
  const root = path.resolve(vaultRoot);
  const dir = path.resolve(targetDir);
  const rel = path.relative(root, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Target path is outside the vault');
  }

  await fs.mkdir(dir, { recursive: true });
  const stamp = timestampSuffix(new Date());
  const candidates = [`${baseName}.md`, `${baseName}-${stamp}.md`];
  for (let i = 2; i <= 20; i++) candidates.push(`${baseName}-${stamp}-${i}.md`);

  for (const name of candidates) {
    try {
      await fs.writeFile(path.join(dir, name), content, { encoding: 'utf-8', flag: 'wx' });
      return path.relative(root, path.join(dir, name)).replace(/\\/g, '/');
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`No free file name found for ${baseName}.md`);
}

const bulletList = (items: string[]) => items.map(item => `- ${sanitizeForVault(item).replace(/\n/g, ' ')}`).join('\n');
const quoteBlock = (text: string) => sanitizeForVault(text).replace(/\n/g, '\n> ');

export interface ResearchBriefContent {
  title: string;
  executiveSummary: string;
  markdownContent: string;
  suggestedNextSteps: string[];
}

export function formatResearchBrief(brief: ResearchBriefContent, acceptedCount: number, lang: Language = outputLanguage()): string {
  const text = serverText(lang);
  const count = Math.max(0, Math.floor(acceptedCount));
  const title = sanitizeForVault(brief.title, 300).replace(/\n/g, ' ');
  return `---
title: ${yamlString(brief.title)}
type: research_brief
rekindle_generated: true
synthesized_at: "${new Date().toISOString()}"
accepted_suggestions_count: ${count}
tags:
  - rekindle/synthesis
  - rekindle/research-brief
---

# ${title}

> [!abstract] ${text.briefSummary}
> ${quoteBlock(brief.executiveSummary)}

${sanitizeForVault(brief.markdownContent, MAX_BODY_LENGTH)}

## ${text.briefNextSteps}
${brief.suggestedNextSteps.map(step => `- [ ] ${sanitizeForVault(step).replace(/\n/g, ' ')}`).join('\n')}

---
*${text.briefFooter(count)}*
`;
}

export interface SynergyNoteContent {
  bridgeTitle: string;
  overview: string;
  sharedProblems: string[];
  mutualBenefits: string[];
  markdownContent: string;
}

export function formatSynergyNote(note: SynergyNoteContent, titleA: string, titleB: string, lang: Language = outputLanguage()): string {
  const text = serverText(lang);
  const title = sanitizeForVault(note.bridgeTitle, 300).replace(/\n/g, ' ');
  const linkA = sanitizeForVault(titleA, 200).replace(/[[\]\n]/g, '');
  const linkB = sanitizeForVault(titleB, 200).replace(/[[\]\n]/g, '');
  return `---
title: ${yamlString(note.bridgeTitle)}
type: cross_project_synergy
rekindle_generated: true
project_a: ${yamlString(titleA)}
project_b: ${yamlString(titleB)}
created_at: "${new Date().toISOString()}"
tags:
  - rekindle/synergy
  - rekindle/cross-project
---

# ${title}

> [!abstract] ${text.synergyOverview}
> ${quoteBlock(note.overview)}

## ${text.synergyProblems}
${bulletList(note.sharedProblems)}

## ${text.synergyBenefits}
${bulletList(note.mutualBenefits)}

${sanitizeForVault(note.markdownContent, MAX_BODY_LENGTH)}

---
*${text.synergyFooter(`[[${linkA}]]`, `[[${linkB}]]`)}*
`;
}
