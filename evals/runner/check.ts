import * as fs from 'fs/promises';
import { z } from 'zod';
import { EvalResult } from '../schema';

export const ThresholdsSchema = z.object({
  checks: z.array(z.object({
    /** Dotted path into the result, e.g. "triage.macroF1". */
    path: z.string(),
    min: z.number().optional(),
    max: z.number().optional(),
  })),
});

function readPath(result: unknown, dotted: string): number | null {
  let current: any = result;
  for (const key of dotted.split('.')) current = current?.[key];
  return typeof current === 'number' ? current : null;
}

/** Returns one message per violated threshold; an unmeasured metric (null) also fails. */
export function checkResult(result: EvalResult, thresholds: z.infer<typeof ThresholdsSchema>): string[] {
  const failures: string[] = [];
  for (const check of thresholds.checks) {
    const value = readPath(result, check.path);
    const label = `${result.meta.config} / ${result.meta.dataset}: ${check.path}`;
    if (value === null) failures.push(`${label} no se midió`);
    else if (check.min !== undefined && value < check.min) failures.push(`${label} = ${value.toFixed(3)} < mínimo ${check.min}`);
    else if (check.max !== undefined && value > check.max) failures.push(`${label} = ${value.toFixed(3)} > máximo ${check.max}`);
  }
  return failures;
}

export async function loadThresholds(file: string) {
  return ThresholdsSchema.parse(JSON.parse(await fs.readFile(file, 'utf-8')));
}
