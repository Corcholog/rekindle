import { describe, it, expect } from 'vitest';
import type { Labels, RunDetails } from '../evals/schema';

// Retrieval-only sweep: re-filters the stored candidates by distance or rank and scores them,
// with no model calls. Expected numbers are computed by hand from the fixture below.
describe('sweepRetrieval', () => {
  const projects = ['Projects/A', 'Projects/B', 'Projects/C'];
  const cases: Labels['cases'] = [
    { article: 'a1', others: 'irrelevant', projects: { 'Projects/A': { verdict: 'actionable' }, 'Projects/B': { verdict: 'tentative' } } },
    { article: 'a2', others: 'irrelevant', projects: {} },
  ];
  const pair = (verdict: 'actionable' | 'tentative' | 'irrelevant') => ({ verdict, confidence: 0.8, reasoning: 'r', action: null });
  const run: RunDetails = {
    config: 'x', configHash: 'h', generatedAt: '2026-01-01T00:00:00Z', k: 3, threshold: 0.6,
    articles: {
      a1: {
        summary: 's',
        retrieval: [
          { project: 'Projects/A', distance: 0.20, level: 'note', note: 'a.md' },
          { project: 'Projects/B', distance: 0.45, level: 'project', note: null },
          { project: 'Projects/C', distance: 0.55, level: 'project', note: null },
        ],
        pairs: { 'Projects/A': pair('actionable'), 'Projects/B': pair('actionable'), 'Projects/C': pair('irrelevant') },
      },
      a2: {
        summary: 's',
        retrieval: [
          { project: 'Projects/B', distance: 0.50, level: 'project', note: null },
          { project: 'Projects/C', distance: 0.58, level: 'project', note: null },
        ],
        pairs: { 'Projects/B': pair('tentative'), 'Projects/C': pair('irrelevant') },
      },
    },
  };

  it('measures what each threshold keeps, drops and costs', async () => {
    const { sweepRetrieval } = await import('../evals/runner/sweep');
    const result = sweepRetrieval({ projects, cases, runs: { x: run }, thresholds: [0.6, 0.5, 0.3], ranks: [1] });
    const byLabel = Object.fromEntries(result.rows.map(r => [r.label, r]));

    // 0.6: 5 candidate pairs over 2 articles; both relevant pairs kept; 3 of 4 irrelevant pairs kept
    expect(byLabel['distancia < 0.60']).toMatchObject({ pairsPerArticle: 2.5, relevantRecall: 1, irrelevantPassRate: 0.75, falseRetrievalRate: 1 });
    // 0.5 (strict): a1 keeps A and B; a2's B at 0.50 is out
    expect(byLabel['distancia < 0.50']).toMatchObject({ pairsPerArticle: 1, relevantRecall: 1, irrelevantPassRate: 0, falseRetrievalRate: 0 });
    // 0.3: only A survives
    expect(byLabel['distancia < 0.30']).toMatchObject({ pairsPerArticle: 0.5, relevantRecall: 0.5 });
    // rank cutoff: the closest project of each article (a1: A, a2: B)
    expect(byLabel['solo el más cercano']).toMatchObject({ pairsPerArticle: 1, relevantRecall: 0.5, irrelevantPassRate: 0.25 });
  });

  it('combines a distance cutoff with a rank cutoff', async () => {
    const { sweepRetrieval } = await import('../evals/runner/sweep');
    const { rows } = sweepRetrieval({ projects, cases, runs: { x: run }, thresholds: [], ranks: [], combos: [[0.5, 1], [0.6, 2]] });
    // < 0.50 and the closest 1: a1 -> A, a2 -> none (B at 0.50 is not below 0.50)
    expect(rows[0]).toMatchObject({ label: 'distancia < 0.50 y los 1 más cercanos', pairsPerArticle: 0.5, relevantRecall: 0.5 });
    // < 0.60 and the closest 2: a1 -> A, B; a2 -> B, C
    expect(rows[1]).toMatchObject({ pairsPerArticle: 2, relevantRecall: 1, irrelevantPassRate: 0.5 });
  });

  it('projects triage quality as if verdicts for kept pairs did not change', async () => {
    const { sweepRetrieval } = await import('../evals/runner/sweep');
    const { rows } = sweepRetrieval({ projects, cases, runs: { x: run }, thresholds: [0.6, 0.5], ranks: [] });
    // 0.6: (2/3 + 0 + 6/7) / 3; 0.5 removes a2's wrong "tentative": (2/3 + 0 + 1) / 3
    expect(rows[0].projected.x.macroF1).toBeCloseTo((2 / 3 + 0 + 6 / 7) / 3, 10);
    expect(rows[1].projected.x.macroF1).toBeCloseTo((2 / 3 + 0 + 1) / 3, 10);
  });

  it('reports how well distance alone separates relevant from irrelevant pairs', async () => {
    const { sweepRetrieval } = await import('../evals/runner/sweep');
    const { separation } = sweepRetrieval({ projects, cases, runs: { x: run }, thresholds: [0.6], ranks: [] });
    // every relevant pair (0.20, 0.45) is closer than every irrelevant one (0.50, 0.55, 0.58, not retrieved)
    expect(separation.auc).toBe(1);
    expect(separation.relevantMedian).toBeCloseTo((0.20 + 0.45) / 2, 10);
    expect(separation.irrelevantMedian).toBe(0.55);
  });
});
