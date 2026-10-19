import { describe, it, expect } from 'vitest';
import {
  precisionRecallAtK, confusionMatrix, classMetrics, connectionMetrics, mean, percentile, noteMatches, estimateCostUsd,
} from '../evals/runner/metrics';

// Numbers below are computed by hand.
describe('retrieval metrics', () => {
  it('computes precision and recall at K', () => {
    // top-2 = [A, B]; relevant = {A, C} -> 1 hit; precision 1/2, recall 1/2
    expect(precisionRecallAtK(['A', 'B', 'C'], ['A', 'C'], 2)).toEqual({ precision: 0.5, recall: 0.5 });
    // K larger than the list uses what was retrieved: hits 2 of 3 retrieved, 2 of 2 relevant
    expect(precisionRecallAtK(['A', 'B', 'C'], ['A', 'C'], 10)).toEqual({ precision: 2 / 3, recall: 1 });
  });

  it('returns null where a metric is undefined', () => {
    expect(precisionRecallAtK([], ['A'], 3)).toEqual({ precision: null, recall: 0 });
    expect(precisionRecallAtK(['A'], [], 3)).toEqual({ precision: 0, recall: null });
  });

  it('averages while ignoring nulls', () => {
    expect(mean([1, null, 0.5])).toBe(0.75);
    expect(mean([null, null])).toBeNull();
  });
});

describe('classification metrics', () => {
  // expected -> predicted: A->A x3, A->T x1, T->T x1, T->I x1, I->I x4, I->A x1
  const pairs = [
    ...Array(3).fill({ expected: 'actionable', predicted: 'actionable' }),
    { expected: 'actionable', predicted: 'tentative' },
    { expected: 'tentative', predicted: 'tentative' },
    { expected: 'tentative', predicted: 'irrelevant' },
    ...Array(4).fill({ expected: 'irrelevant', predicted: 'irrelevant' }),
    { expected: 'irrelevant', predicted: 'actionable' },
  ] as const;

  it('builds the confusion matrix', () => {
    const m = confusionMatrix([...pairs]);
    expect(m.actionable).toEqual({ actionable: 3, tentative: 1, irrelevant: 0 });
    expect(m.tentative).toEqual({ actionable: 0, tentative: 1, irrelevant: 1 });
    expect(m.irrelevant).toEqual({ actionable: 1, tentative: 0, irrelevant: 4 });
  });

  it('computes precision, recall, F1 and macro F1', () => {
    const { perClass, macroF1 } = classMetrics(confusionMatrix([...pairs]));
    // actionable: tp 3, fp 1, fn 1 -> P .75 R .75 F1 .75
    expect(perClass.actionable).toMatchObject({ precision: 0.75, recall: 0.75, f1: 0.75, support: 4 });
    // tentative: tp 1, fp 1, fn 1 -> P .5 R .5 F1 .5
    expect(perClass.tentative).toMatchObject({ precision: 0.5, recall: 0.5, f1: 0.5, support: 2 });
    // irrelevant: tp 4, fp 1, fn 1 -> P .8 R .8 F1 .8
    expect(perClass.irrelevant).toMatchObject({ precision: 0.8, recall: 0.8, f1: 0.8, support: 5 });
    expect(macroF1).toBeCloseTo((0.75 + 0.5 + 0.8) / 3, 10);
  });

  it('leaves out classes that never occur', () => {
    const { perClass, macroF1 } = classMetrics(confusionMatrix([{ expected: 'irrelevant', predicted: 'irrelevant' }]));
    expect(perClass.actionable.f1).toBeNull();
    expect(macroF1).toBe(1);
  });
});

describe('helpers', () => {
  it('computes nearest-rank percentiles', () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([], 50)).toBeNull();
  });

  it('matches target notes by path, file name or title', () => {
    expect(noteMatches('research/combat.md', 'research/combat.md')).toBe(true);
    expect(noteMatches('combat.md', 'research/combat.md')).toBe(true);
    expect(noteMatches('Combat', 'research/combat.md')).toBe(true);
    expect(noteMatches('combat.md', 'research/sources.md')).toBe(false);
    expect(noteMatches('combat.md', null)).toBe(false);
  });

  it('scores connections found, where actionable and tentative are the same answer', () => {
    const m = confusionMatrix([
      { expected: 'actionable', predicted: 'tentative' }, // still a connection
      { expected: 'tentative', predicted: 'actionable' }, // still a connection
      { expected: 'actionable', predicted: 'irrelevant' }, // lost
      { expected: 'irrelevant', predicted: 'tentative' }, // invented
      { expected: 'irrelevant', predicted: 'irrelevant' },
    ]);
    expect(connectionMetrics(m)).toEqual({ precision: 2 / 3, recall: 2 / 3, f1: 2 / 3, support: 3 });
    expect(connectionMetrics(confusionMatrix([{ expected: 'irrelevant', predicted: 'irrelevant' }]))).toEqual({ precision: null, recall: null, f1: null, support: 0 });
  });

  it('estimates cost from tokens and a price table', () => {
    // 2M input at $0.30/M + 1M output at $1.20/M = 0.6 + 1.2
    expect(estimateCostUsd({ promptTokens: 2_000_000, completionTokens: 1_000_000 }, { inputPerM: 0.3, outputPerM: 1.2 })).toBeCloseTo(1.8, 10);
    expect(estimateCostUsd(undefined, { inputPerM: 0.3, outputPerM: 1.2 })).toBe(0);
  });

  it('averages tokens per call, with cache hits and thinking as parts of the totals', async () => {
    const { tokensPerCall } = await import('../evals/runner/run');
    expect(tokensPerCall([
      { promptTokens: 2000, cachedPromptTokens: 1500, completionTokens: 900, reasoningTokens: 600 },
      { promptTokens: 1000, completionTokens: 100 },
      undefined,
    ])).toEqual({ prompt: 1500, cachedPrompt: 750, completion: 500, reasoning: 300 });
    expect(tokensPerCall([undefined])).toBeNull();
  });
});
