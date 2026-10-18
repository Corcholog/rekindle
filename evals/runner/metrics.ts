export type Verdict = 'actionable' | 'tentative' | 'irrelevant';
export const VERDICTS: readonly Verdict[] = ['actionable', 'tentative', 'irrelevant'];

export function precisionRecallAtK(retrieved: string[], relevant: string[], k: number) {
  const top = retrieved.slice(0, k);
  const hits = top.filter(id => relevant.includes(id)).length;
  return {
    precision: top.length > 0 ? hits / top.length : null,
    recall: relevant.length > 0 ? hits / relevant.length : null,
  };
}

/** Mean of the defined values, or null when none are. */
export function mean(values: (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null);
  return defined.length > 0 ? defined.reduce((a, b) => a + b, 0) / defined.length : null;
}

export type ConfusionMatrix = Record<Verdict, Record<Verdict, number>>;

/** matrix[expected][predicted] */
export function confusionMatrix(pairs: { expected: Verdict; predicted: Verdict }[]): ConfusionMatrix {
  const matrix = Object.fromEntries(
    VERDICTS.map(e => [e, Object.fromEntries(VERDICTS.map(p => [p, 0]))]),
  ) as ConfusionMatrix;
  for (const { expected, predicted } of pairs) matrix[expected][predicted]++;
  return matrix;
}

export interface ClassMetric {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  support: number;
}

export function classMetrics(matrix: ConfusionMatrix) {
  const perClass = {} as Record<Verdict, ClassMetric>;
  for (const cls of VERDICTS) {
    const tp = matrix[cls][cls];
    const fn = VERDICTS.reduce((sum, p) => sum + (p === cls ? 0 : matrix[cls][p]), 0);
    const fp = VERDICTS.reduce((sum, e) => sum + (e === cls ? 0 : matrix[e][cls]), 0);
    const support = tp + fn;
    perClass[cls] = {
      precision: tp + fp > 0 ? tp / (tp + fp) : null,
      recall: support > 0 ? tp / support : null,
      f1: support + fp > 0 ? (2 * tp) / (2 * tp + fp + fn) : null, // class absent from labels and predictions: undefined
      support,
    };
  }
  return { perClass, macroF1: mean(VERDICTS.map(c => perClass[c].f1)) };
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const normalizeNote = (note: string) => note.trim().toLowerCase().replace(/\\/g, '/').replace(/\.md$/, '');

/** A predicted target note matches the label by full path, file name or title. */
export function noteMatches(expected: string, predicted: string | null): boolean {
  if (!predicted) return false;
  const e = normalizeNote(expected);
  const p = normalizeNote(predicted);
  return e === p || p.endsWith(`/${e}`) || e.endsWith(`/${p}`);
}

export { estimateCostUsd } from '../../src/ai/pricing';
export type { PriceTable } from '../../src/ai/pricing';
