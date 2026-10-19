import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Attempt, Usage } from '../../src/ai/types';

export const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** A JSON file of key -> value entries, written with sorted keys so diffs stay readable. */
export class JsonCache<T> {
  private entries = new Map<string, T>();
  private dirty = false;

  constructor(private file: string) {}

  async load(): Promise<this> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf-8')) as Record<string, T>;
      this.entries = new Map(Object.entries(raw));
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  get(key: string): T | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T): void {
    this.entries.set(key, value);
    this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const sorted = Object.fromEntries([...this.entries].sort(([a], [b]) => a.localeCompare(b)));
    // Temp file + rename: a crash mid-write must not destroy paid-for recordings
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(sorted), 'utf-8');
    await fs.rename(tmp, this.file);
    this.dirty = false;
  }
}

/** Embeddings keep 6 decimals: smaller files, and live and replay runs see identical vectors. */
export const roundVector = (vector: number[]) => vector.map(v => Math.round(v * 1e6) / 1e6);

export type RecordedCall =
  | { ok: true; data: unknown; model: string; usage?: Usage; latencyMs: number; attempts: Attempt[] }
  | { ok: false; attempts: Attempt[] };
