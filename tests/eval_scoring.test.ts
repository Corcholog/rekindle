import { describe, it, expect } from 'vitest';
import type { Labels } from '../evals/schema';

// scoreRun is shared by the runner and the review page, so both always report the same numbers.
// Expected values are computed by hand from the fixture below.
describe('scoreRun', () => {
  const projects = ['Projects/A', 'Projects/B', 'Projects/C'];
  const cases: Labels['cases'] = [
    // a1: A actionable (target a.md), B tentative, C blank -> irrelevant via "others"
    { article: 'a1', others: 'irrelevant' as const, projects: {
      'Projects/A': { verdict: 'actionable' as const, target_note: 'a.md' },
      'Projects/B': { verdict: 'tentative' as const },
    } },
    // a2: nothing relevant anywhere
    { article: 'a2', others: 'irrelevant' as const, projects: {} },
    // a3: not labeled at all -> excluded
    { article: 'a3', others: null, projects: {} },
  ];
  const predictions = {
    a1: {
      retrieved: ['Projects/A', 'Projects/C', 'Projects/B'],
      pairs: {
        'Projects/A': { verdict: 'actionable' as const, targetFile: 'notes/a.md' },
        'Projects/B': { verdict: 'actionable' as const, targetFile: 'b.md' },
        'Projects/C': { verdict: 'irrelevant' as const, targetFile: null },
      },
    },
    a2: {
      retrieved: ['Projects/B'],
      pairs: { 'Projects/B': { verdict: 'tentative' as const, targetFile: null } },
    },
    a3: { retrieved: [], pairs: {} },
  };

  it('computes retrieval, triage and target-note numbers', async () => {
    const { scoreRun } = await import('../evals/runner/scoring');
    const score = scoreRun({ projects, cases, predictions, k: 2 });

    // cases scored: a1, a2 -> pairs: 3 + 3
    expect(score.cases).toBe(2);
    expect(score.labeledPairs).toBe(6);

    // a1: top-2 = [A, C], relevant {A, B} -> P 1/2, R 1/2; a2 has no relevant project and retrieved B
    expect(score.retrieval).toMatchObject({
      precisionAtK: 0.5, recallAtK: 0.5, casesWithRelevant: 1, casesWithoutRelevant: 1, falseRetrievalRate: 1,
    });

    // pairs (expected -> predicted): A act->act, B tent->act, C irr->irr, A irr->irr (not evaluated), B irr->tent, C irr->irr
    expect(score.triage.confusion.actionable).toEqual({ actionable: 1, tentative: 0, irrelevant: 0 });
    expect(score.triage.confusion.tentative).toEqual({ actionable: 1, tentative: 0, irrelevant: 0 });
    expect(score.triage.confusion.irrelevant).toEqual({ actionable: 0, tentative: 1, irrelevant: 3 });
    // actionable: tp1 fp1 fn0 -> F1 2/3; tentative: tp0 fp1 fn1 -> 0; irrelevant: tp3 fp0 fn1 -> 6/7
    expect(score.triage.macroF1).toBeCloseTo((2 / 3 + 0 + 6 / 7) / 3, 10);

    // one labeled target note (a.md); the prediction notes/a.md matches it by file name
    expect(score.triage).toMatchObject({ targetNoteAccuracy: 1, targetNoteCases: 1 });
  });

  it('treats a non-retrieved project as irrelevant and a wrong target as a miss', async () => {
    const { scoreRun } = await import('../evals/runner/scoring');
    const wrong = { ...predictions, a1: { ...predictions.a1, pairs: { ...predictions.a1.pairs, 'Projects/A': { verdict: 'actionable' as const, targetFile: 'other.md' } } } };
    expect(scoreRun({ projects, cases, predictions: wrong, k: 2 }).triage.targetNoteAccuracy).toBe(0);

    const missing = { ...predictions, a1: { retrieved: [], pairs: {} } };
    const score = scoreRun({ projects, cases, predictions: missing, k: 2 });
    expect(score.triage.confusion.actionable).toEqual({ actionable: 0, tentative: 0, irrelevant: 1 });
  });
});
