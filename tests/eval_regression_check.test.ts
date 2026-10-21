import { describe, it, expect } from 'vitest';

describe('eval regression check', () => {
  const result = (overrides: object = {}) => ({
    meta: { config: 'c', dataset: 'd' },
    retrieval: { recallAtK: 0.9 },
    triage: { macroF1: 0.7 },
    reliability: { failures: 0 },
    ...overrides,
  }) as any;
  const thresholds = {
    checks: [
      { path: 'retrieval.recallAtK', min: 0.8 },
      { path: 'triage.macroF1', min: 0.5 },
      { path: 'reliability.failures', max: 0 },
    ],
  };

  it('passes when every metric is within bounds', async () => {
    const { checkResult } = await import('../evals/runner/check');
    expect(checkResult(result(), thresholds)).toEqual([]);
  });

  it('fails when a metric drops below its minimum, exceeds its maximum or was not measured', async () => {
    const { checkResult } = await import('../evals/runner/check');
    const failures = checkResult(result({
      triage: { macroF1: 0.4 }, reliability: { failures: 2 }, retrieval: { recallAtK: null },
    }), thresholds);
    expect(failures).toHaveLength(3);
    expect(failures.join('\n')).toMatch(/macroF1 = 0\.400 < mínimo 0\.5/);
    expect(failures.join('\n')).toMatch(/failures = 2\.000 > máximo 0/);
    expect(failures.join('\n')).toMatch(/recallAtK no se midió/);
  });
});
