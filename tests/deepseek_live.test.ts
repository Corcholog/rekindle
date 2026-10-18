import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Live check against the real DeepSeek API with a tiny synthetic prompt (fractions of a cent).
// Skipped unless DEEPSEEK_API_KEY is set.
const hasKey = Boolean(process.env.DEEPSEEK_API_KEY);
const schema = z.object({ verdict: z.enum(['actionable', 'tentative', 'irrelevant']), reason: z.string() });

describe.skipIf(!hasKey)('DeepSeek live API', () => {
  it('returns schema-valid JSON with thinking off, and usage', async () => {
    const { DeepSeekProvider } = await import('../src/ai/providers/deepseek');
    const provider = new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY!, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash' });

    const result = await provider.complete(
      'Clasificas si un artículo es relevante para un proyecto de escritura. Responde en español.',
      'PROYECTO: ensayo sobre la muerte en el anime.\nARTÍCULO: receta de pan de masa madre.',
      schema,
    );

    expect(schema.safeParse(result.data).success).toBe(true);
    expect(result.data.verdict).toBe('irrelevant');
    expect(result.usage?.promptTokens).toBeGreaterThan(0);
    expect(result.usage?.completionTokens).toBeGreaterThan(0);
  }, 60000);
});
