import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// Committed configs must parse, and the ones that are compared must share the same summaries.
describe('committed eval configs', () => {
  it('parse and use identical summary providers', async () => {
    const { loadConfig } = await import('../evals/runner/run');
    const dir = 'evals/configs';
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json') && f !== 'thresholds.json');
    expect(files.length).toBeGreaterThanOrEqual(3);

    const configs = await Promise.all(files.map(f => loadConfig(path.join(dir, f))));
    expect(new Set(configs.map(c => c.config.name)).size).toBe(configs.length);
    expect(new Set(configs.map(c => JSON.stringify(c.config.summaryProviders))).size).toBe(1);
    // DeepSeek runs must always say whether thinking is on
    for (const { config } of configs) {
      for (const p of [...config.providers, ...config.summaryProviders].filter(p => p.name === 'deepseek')) {
        expect(p.thinking, `${config.name} must set thinking explicitly`).toBeTypeOf('boolean');
      }
    }
  });
});
