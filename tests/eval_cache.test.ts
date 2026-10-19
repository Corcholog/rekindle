import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { JsonCache } from '../evals/runner/cache';

// Eval caches hold paid-for model answers; a save goes through a temp file and a rename, so an
// interrupted write leaves the previous file intact.
describe('JsonCache', () => {
  let dir: string;
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it('saves atomically and leaves no temp file', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-cache-'));
    const file = path.join(dir, 'cache', 'llm.json');
    const cache = await new JsonCache<string>(file).load();
    cache.set('b', '2');
    cache.set('a', '1');
    await cache.save();
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ a: '1', b: '2' });
    expect(await fs.readdir(path.dirname(file))).toEqual(['llm.json']);

    const reloaded = await new JsonCache<string>(file).load();
    expect(reloaded.get('a')).toBe('1');
  });
});
