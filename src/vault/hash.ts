import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

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
 * Calculates deterministic hash of a project directory.
 * Hashes only top-level *.md files that the reconciler parses, ignoring suggestions.md.
 * Incorporates file names so renaming a file triggers reconciliation.
 */
export async function getDirectoryHash(dirPath: string): Promise<string> {
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return ''; // Directory doesn't exist or isn't accessible
  }

  // Filter to only .md files that the reconciler actually consumes
  const mdFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'suggestions.md')
    .sort((a, b) => a.name.localeCompare(b.name));

  if (mdFiles.length === 0) return '';

  const finalHash = crypto.createHash('sha256');

  for (const file of mdFiles) {
    const fullPath = path.join(dirPath, file.name);
    // Include file name to reflect title/content renaming
    finalHash.update(`filename:${file.name}:`);
    try {
      const fileHash = await getFileHash(fullPath);
      finalHash.update(fileHash);
    } catch {
      // If a file cannot be read, continue
    }
  }

  return finalHash.digest('hex');
}

