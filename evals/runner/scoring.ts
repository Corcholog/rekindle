import { Labels, RunDetails } from '../schema';
import { effectiveVerdict } from './dataset';
import {
  classMetrics, confusionMatrix, connectionMetrics, mean, precisionRecallAtK, Verdict,
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
  const precisions: (number | null)[] = [];
  const recalls: (number | null)[] = [];
  let scoredCases = 0;
  let casesWithRelevant = 0;
  let negativeCases = 0;
  let falseRetrievals = 0;

  for (const labelCase of cases) {
    const entries = projects
      .map(folder => [folder, effectiveVerdict(labelCase, folder)] as const)
      .filter(([, verdict]) => verdict !== null);
    if (entries.length === 0) continue;
    scoredCases++;

    const prediction = predictions[labelCase.article] ?? { retrieved: [], pairs: {} };
    for (const [folder, verdict] of entries) {
      pairs.push({ expected: verdict as Verdict, predicted: prediction.pairs[folder]?.verdict ?? 'irrelevant' });
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
      connection: connectionMetrics(confusion),
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

/**
 * Where a run's suggestions point, without labels: actions whose note is not the one retrieval found
 * closest for that project, and actions proposing a new note.
 */
export function targetNoteStats(details: RunDetails): { actions: number; notClosestNote: number; newNotes: number } {
  let actions = 0;
  let notClosestNote = 0;
  let newNotes = 0;
  for (const article of Object.values(details.articles)) {
    for (const [project, pair] of Object.entries(article.pairs)) {
      if (!pair.action) continue;
      actions++;
      if (pair.action.targetIsNew) newNotes++;
      const closest = article.retrieval.find(r => r.project === project)?.note ?? null;
      if (pair.action.targetFile !== closest) notClosestNote++;
    }
  }
  return { actions, notClosestNote, newNotes };
}

// A reasoning that opens by describing the article or the project instead of the connection
const OPENS_WITH_SUMMARY = /^(el (artículo|proyecto|contenido|texto|resumen)|the (article|project|content|text|summary))\b/i;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * The shape of what the model wrote, without labels: how many actions came as steps, how many steps
 * carry text to paste or point at another note than the target, the length of the action text
 * (headline and steps), and for tentatives the length of the reasoning as shown (the laid-out
 * connection and gap when there are), whether it says what is missing, and how many still open by
 * describing the article or the project.
 */
export function suggestionTextStats(details: RunDetails) {
  let actions = 0, actionsWithSteps = 0, steps = 0, stepsWithText = 0, stepsOnOtherNote = 0;
  let tentatives = 0, tentativesWithGap = 0, tentativesOpeningWithSummary = 0;
  const actionChars: number[] = [];
  const tentativeChars: number[] = [];
  for (const article of Object.values(details.articles)) {
    for (const pair of Object.values(article.pairs)) {
      if (pair.action) {
        actions++;
        const actionSteps = pair.action.steps ?? [];
        if (actionSteps.length) actionsWithSteps++;
        steps += actionSteps.length;
        stepsWithText += actionSteps.filter(s => s.text).length;
        stepsOnOtherNote += actionSteps.filter(s => s.note && s.note !== pair.action!.targetFile).length;
        actionChars.push(pair.action.suggestedAction.length + actionSteps.reduce((sum, s) => sum + (s.where?.length ?? 0) + s.change.length + (s.text?.length ?? 0), 0));
      }
      if (pair.verdict === 'tentative') {
        tentatives++;
        if (pair.reasoningGap) tentativesWithGap++;
        // What the owner reads: the laid-out connection and gap, or the model's own reasoning
        const reasoning = pair.reasoningConnection ? [pair.reasoningConnection, pair.reasoningGap].filter(Boolean).join('\n\n') : (pair.reasoning ?? '');
        tentativeChars.push(reasoning.length);
        if (OPENS_WITH_SUMMARY.test(reasoning.trim())) tentativesOpeningWithSummary++;
      }
    }
  }
  return {
    actions, actionsWithSteps, steps, stepsWithText, stepsOnOtherNote, actionCharsP50: median(actionChars),
    tentatives, tentativesWithGap, tentativeReasoningCharsP50: median(tentativeChars), tentativesOpeningWithSummary,
  };
}
