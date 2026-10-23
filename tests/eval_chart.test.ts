import { describe, it, expect } from 'vitest';
import { chartPoints, renderChart } from '../evals/runner/chart';

// The README chart is generated from result files: counts must come straight from them.
describe('eval connections chart', () => {
  const result = (config: string, startedAt: string, recall: number, irrActionable: number, irrTentative: number) => ({
    meta: { config, dataset: 'private', startedAt },
    triage: {
      connection: { precision: 0.7, recall, f1: 0.7, support: 56 },
      confusion: { irrelevant: { actionable: irrActionable, tentative: irrTentative, irrelevant: 300 } },
    },
  }) as any;

  it('counts connections found and extra ones from the latest result of each config', () => {
    const points = chartPoints([
      result('deepseek-flash-top3-chunks', '2026-01-01', 0.5, 0, 0), // older run, ignored
      result('deepseek-flash-top3-chunks', '2026-01-02', 46 / 56, 0, 19),
      result('qwen-local-top3-notes', '2026-01-02', 32 / 56, 0, 9),
      result('qwen-local-top3', '2026-01-02', 1, 0, 0), // replaced by the notes-prompt run,
      result('not-in-chart', '2026-01-02', 1, 0, 0),
    ], 'private');
    expect(points.map(p => [p.config, p.found, p.extra, p.total])).toEqual([
      ['deepseek-flash-top3-chunks', 46, 19, 56],
      ['qwen-local-top3-notes', 32, 9, 56],
    ]);

    const svg = renderChart(points);
    expect(svg).toContain('46 found, 19 extra');
    expect(svg).toContain('of 56 labeled connections');
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it('refuses to draw without the connection metric', () => {
    expect(() => renderChart(chartPoints([], 'private'))).toThrow();
  });
});
