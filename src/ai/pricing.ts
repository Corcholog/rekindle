// List prices used to estimate LLM cost, in USD per million tokens. Shared by the production
// telemetry and the eval harness (whose configs carry their own tables).

export interface PriceTable {
  inputPerM: number;
  outputPerM: number;
}

export function estimateCostUsd(usage: { promptTokens?: number; completionTokens?: number } | undefined, price: PriceTable): number {
  if (!usage) return 0;
  return ((usage.promptTokens ?? 0) * price.inputPerM + (usage.completionTokens ?? 0) * price.outputPerM) / 1_000_000;
}

/**
 * Production price table, keyed "provider:model".
 * - DeepSeek Flash: list price at peak hours with a cache miss (api-docs.deepseek.com, checked
 *   2026-10-18), so estimates are an upper bound.
 * - Ollama runs locally: no cloud cost.
 * - Gemini is left out on purpose: the free tier costs nothing, a paid key does, and Loom cannot
 *   tell which one is configured. Its calls are reported as "not priced".
 */
export const DEFAULT_PRICES: Record<string, PriceTable> = {
  'deepseek:deepseek-flash': { inputPerM: 0.3, outputPerM: 1.2 },
};

export function priceFor(provider: string, model: string, prices: Record<string, PriceTable> = DEFAULT_PRICES): PriceTable | undefined {
  if (provider === 'ollama') return { inputPerM: 0, outputPerM: 0 };
  return prices[`${provider}:${model}`];
}

/** Estimated cost of one attempt, or null when the model has no price or reported no usage. */
export function attemptCostUsd(provider: string, model: string, usage: { promptTokens?: number; completionTokens?: number } | undefined): number | null {
  const price = priceFor(provider, model);
  if (!price || !usage) return null;
  return estimateCostUsd(usage, price);
}
