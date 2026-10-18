import { Labels, RunDetails } from '../schema';
import { effectiveVerdict } from './dataset';
import {
  classMetrics, confusionMatrix, mean, noteMatches, precisionRecallAtK, Verdict,
} from './metrics';

export interface PairPrediction {
  verdict: Verdict;
  /** File the suggestion targets, when the model proposed an action. */
  targetFile: string | null;
}

export interface ArticlePrediction {
  /** Project folders in retrieval order, closest first. */
  retrieved: string[];
  /** A project absent here was not evaluated, which counts as irrelevant. */
  pairs: Record<string, PairPrediction>;
}

export interface ScoreInput {
  projects: string[];
  cases: Labels['cases'];
  predictions: Record<string, ArticlePrediction>;
  k: number;
}

/**
 * Scores predictions against the owner's labels. Used by the runner and by the review page, so
 * both always report the same numbers. Articles without any answered pair are left out.
 */
export function scoreRun({ projects, cases, predictions, k }: ScoreInput) {
  const pairs: { expected: Verdict; predicted: Verdict }[] = [];
  const targetChecks: boolean[] = [];
  const precisions: (number | null)[] = [];
  const recalls: (number | null)[] = [];
  let scoredCases = 0;
  let casesWithRelevant = 0;
  let negativeCases = 0;
  let falseRetrievals = 0;

  for (const labelCase of cases) {
    const entries = projects
      .map(folder => [folder, effectiveVerdict(labelCase, folder), labelCase.projects[folder]] as const)
      .filter(([, verdict]) => verdict !== null);
    if (entries.length === 0) continue;
    scoredCases++;

    const prediction = predictions[labelCase.article] ?? { retrieved: [], pairs: {} };
    for (const [folder, verdict, label] of entries) {
      const expected = verdict as Verdict;
      const answered = prediction.pairs[folder];
      const got: Verdict = answered?.verdict ?? 'irrelevant';
      pairs.push({ expected, predicted: got });
      if (label?.target_note && expected === 'actionable') {
        targetChecks.push(got === 'actionable' && noteMatches(label.target_note, answered?.targetFile ?? null));
      }
    }

    const relevant = entries.filter(([, verdict]) => verdict !== 'irrelevant').map(([folder]) => folder);
    const retrieved = prediction.retrieved.slice(0, k);
    if (relevant.length > 0) {
      casesWithRelevant++;
      const { precision, recall } = precisionRecallAtK(prediction.retrieved, relevant, k);
      precisions.push(precision);
      recalls.push(recall);
    } else {
      negativeCases++;
      if (retrieved.length > 0) falseRetrievals++;
    }
  }

  const confusion = confusionMatrix(pairs);
  const { perClass, macroF1 } = classMetrics(confusion);
  return {
    cases: scoredCases,
    labeledPairs: pairs.length,
    retrieval: {
      k,
      precisionAtK: mean(precisions),
      recallAtK: mean(recalls),
      casesWithRelevant,
      falseRetrievalRate: negativeCases > 0 ? falseRetrievals / negativeCases : null,
      casesWithoutRelevant: negativeCases,
    },
    triage: {
      confusion,
      perClass,
      macroF1,
      targetNoteAccuracy: targetChecks.length > 0 ? targetChecks.filter(Boolean).length / targetChecks.length : null,
      targetNoteCases: targetChecks.length,
    },
  };
}

/** Rebuilds scoring input from a run's detail file, so labels can be rescored without a run. */
export function predictionsFromDetails(details: RunDetails): Record<string, ArticlePrediction> {
  return Object.fromEntries(Object.entries(details.articles).map(([articleId, article]) => [
    articleId,
    {
      retrieved: article.retrieval.map(r => r.project),
      pairs: Object.fromEntries(Object.entries(article.pairs).map(([project, pair]) => [
        project,
        { verdict: pair.verdict, targetFile: pair.action?.targetFile ?? null },
      ])),
    },
  ]));
}
