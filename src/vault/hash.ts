import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { isGeneratedNote } from './generatedNotes';
import { MAX_NOTE_BYTES } from './parser';

/**
 * Calculates SHA256 hash of a file's contents via streaming.
 */
export async function getFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

/**
 * Changes when what a snapshot stores changes, so every project is reconciled once after an upgrade.
 * v2: notes are stored in full, not cut at 4,000 characters.
 * v3: oversized and binary notes are left out and recorded; embedded binary data is removed.
 * v4: long notes are also stored as pieces with their own embeddings (chunker.ts).
 */
const SNAPSHOT_FORMAT = 'snapshot-format:4:';

/**
 * Calculates deterministic hash of a project directory.
 * Hashes the *.md files the reconciler parses (recursively), ignoring suggestions.md and Rekindle-generated notes.
 * Incorporates file names so renaming a file triggers reconciliation.
 */
export async function getDirectoryHash(dirPath: string): Promise<string> {
  const mdFiles: { fullPath: string; relPath: string }[] = [];

  async function walk(currentDir: string) {
    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // Skip hidden dirs like .obsidian, .git
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.md') && lower !== 'suggestions.md' && !(await isGeneratedNote(full))) {
          const rel = path.relative(dirPath, full).replace(/\\/g, '/');
          mdFiles.push({ fullPath: full, relPath: rel });
        }
      }
    }
  }

  await walk(dirPath);

  if (mdFiles.length === 0) return '';

  mdFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const finalHash = crypto.createHash('sha256');
  finalHash.update(SNAPSHOT_FORMAT);

  for (const file of mdFiles) {
    finalHash.update(`filename:${file.relPath}:`);
    try {
      // A file the parser will not read is identified by size and time, not by streaming it whole
      const stat = await fsp.stat(file.fullPath);
      finalHash.update(stat.size > MAX_NOTE_BYTES ? `large:${stat.size}:${stat.mtimeMs}` : await getFileHash(file.fullPath));
    } catch {
      // If a file cannot be read, continue
    }
  }

  return finalHash.digest('hex');
}

