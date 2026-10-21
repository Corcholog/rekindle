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

  it('computes retrieval and triage numbers', async () => {
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

    // Connection found (actionable or tentative vs irrelevant): tentative->actionable is a hit;
    // tp 2 (A act->act, B tent->act), fn 0, fp 1 (B irr->tent)
    expect(score.triage.connection).toEqual({ precision: 2 / 3, recall: 1, f1: 0.8, support: 2 });

    // Target notes are labeled but no longer scored (evals/README.md)
    expect(score.triage).not.toHaveProperty('targetNoteAccuracy');
  });

  it('treats a non-retrieved project as irrelevant', async () => {
    const { scoreRun } = await import('../evals/runner/scoring');
    const missing = { ...predictions, a1: { retrieved: [], pairs: {} } };
    const score = scoreRun({ projects, cases, predictions: missing, k: 2 });
    expect(score.triage.confusion.actionable).toEqual({ actionable: 0, tentative: 0, irrelevant: 1 });
  });
});

describe('targetNoteStats', () => {
  it('counts actions away from the closest note and proposed new notes, from the detail file alone', async () => {
    const { targetNoteStats } = await import('../evals/runner/scoring');
    const action = (targetFile: string, targetIsNew?: boolean) => ({ type: 'evidence_citation', observation: 'o', suggestedAction: 's', targetFile, targetIsNew });
    const pair = (a: ReturnType<typeof action> | null) => ({ verdict: a ? 'actionable' as const : 'tentative' as const, confidence: 0.8, reasoning: 'r', action: a });
    const details = {
      config: 'c', configHash: 'h', generatedAt: '', k: 3, threshold: 0.6,
      articles: {
        a1: {
          summary: 's',
          retrieval: [
            { project: 'Projects/A', distance: 0.3, level: 'note' as const, note: 'a.md' },
            { project: 'Projects/B', distance: 0.4, level: 'note' as const, note: 'b.md' },
            { project: 'Projects/C', distance: 0.5, level: 'project' as const, note: null },
          ],
          pairs: {
            'Projects/A': pair(action('a.md')), // the closest note
            'Projects/B': pair(action('research/otra.md')), // another existing note
            'Projects/C': pair(null), // no action
          },
        },
        a2: {
          summary: 's',
          retrieval: [{ project: 'Projects/A', distance: 0.3, level: 'note' as const, note: 'a.md' }],
          pairs: { 'Projects/A': pair(action('nueva.md', true)) }, // a new note; recorded before the flag existed, it would read false
        },
      },
    };
    expect(targetNoteStats(details as any)).toEqual({ actions: 3, notClosestNote: 2, newNotes: 1 });
  });
});

describe('suggestionTextStats', () => {
  it('counts steps, text to paste, and tentatives that open with a summary', async () => {
    const { suggestionTextStats } = await import('../evals/runner/scoring');
    const step = (note: string | null, text: string | null) => ({ note, noteIsNew: false, where: 'Acto 2', change: 'Añadir.', text });
    const details: any = {
      articles: {
        a1: {
          pairs: {
            'Projects/A': { verdict: 'actionable', reasoning: 'Conecta.', action: { suggestedAction: 'Titular', targetFile: 'a.md', steps: [step('a.md', 'Cita'), step('b.md', null)] } },
            'Projects/B': { verdict: 'tentative', reasoning: 'El artículo trata de faros.\n\nNo aporta datos.', reasoningGap: 'No aporta datos.', action: null },
          },
        },
        a2: {
          pairs: {
            // Recorded before steps: the whole action in one text, the reasoning in one text
            'Projects/A': { verdict: 'actionable', reasoning: 'r', action: { suggestedAction: 'Una acción larga en un bloque', targetFile: 'a.md' } },
            // Laid out by the second call: the connection and gap are what is shown and counted
            'Projects/B': { verdict: 'tentative', reasoning: 'El artículo trata de otra cosa, pero toca el Acto 1.', reasoningConnection: 'Toca el Acto 1,', reasoningGap: 'sin datos.', action: null },
          },
        },
      },
    };
    // Action text: 'Titular' (7) + 'Acto 2' 'Añadir.' 'Cita' (17) + 'Acto 2' 'Añadir.' (13) = 37, and 29;
    // with two values the median is the upper one
    expect(suggestionTextStats(details)).toEqual({
      actions: 2, actionsWithSteps: 1, steps: 2, stepsWithText: 1, stepsOnOtherNote: 1, actionCharsP50: 37,
      tentatives: 2, tentativesWithGap: 2, tentativeReasoningCharsP50: 45, tentativesOpeningWithSummary: 1,
    });
  });
});
