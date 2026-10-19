// List prices used to estimate LLM cost, in USD per million tokens. Shared by the production
// telemetry and the eval harness (whose configs carry their own tables).

export interface PriceTable {
  inputPerM: number;
  outputPerM: number;
  /** Input tokens served from the provider's prompt cache. Defaults to inputPerM. */
  cachedInputPerM?: number;
  /** Peak windows as [start, end) UTC hours, Monday to Friday. Without them every hour is peak. */
  peakHoursUtc?: Array<[number, number]>;
  /** Multiplier for every price outside the peak windows (DeepSeek: 0.5). */
  offPeakFactor?: number;
}

export interface PricedUsage {
  promptTokens?: number;
  completionTokens?: number;
  /** Part of promptTokens served from the cache. */
  cachedPromptTokens?: number;
}

export function isPeak(at: Date, price: PriceTable): boolean {
  if (!price.peakHoursUtc) return true;
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return price.peakHoursUtc.some(([start, end]) => hour >= start && hour < end);
}

/**
 * Without a time the call is priced at peak, so the estimate is an upper bound. Provider holidays
 * (DeepSeek: Chinese public holidays are off-peak) are not modeled, which also errs high.
 */
export function estimateCostUsd(usage: PricedUsage | undefined, price: PriceTable, at?: Date): number {
  if (!usage) return 0;
  const cached = Math.min(usage.cachedPromptTokens ?? 0, usage.promptTokens ?? 0);
  const uncached = (usage.promptTokens ?? 0) - cached;
  const factor = at && !isPeak(at, price) ? price.offPeakFactor ?? 1 : 1;
  const usd = uncached * price.inputPerM + cached * (price.cachedInputPerM ?? price.inputPerM) + (usage.completionTokens ?? 0) * price.outputPerM;
  return (usd * factor) / 1_000_000;
}

/**
 * Production price table, keyed "provider:model".
 * - DeepSeek Flash: api-docs.deepseek.com/quick_start/pricing, checked 2026-10-19. Peak is
 *   01:00–04:00 and 06:00–10:00 UTC on weekdays; off-peak prices are half.
 * - Ollama runs locally: no cloud cost.
 * - Gemini is left out on purpose: the free tier costs nothing, a paid key does, and Rekindle cannot
 *   tell which one is configured. Its calls are reported as "not priced".
 */
export const DEFAULT_PRICES: Record<string, PriceTable> = {
  'deepseek:deepseek-flash': {
    inputPerM: 0.3, cachedInputPerM: 0.006, outputPerM: 1.2, peakHoursUtc: [[1, 4], [6, 10]], offPeakFactor: 0.5,
  },
};

export function priceFor(provider: string, model: string, prices: Record<string, PriceTable> = DEFAULT_PRICES): PriceTable | undefined {
  if (provider === 'ollama') return { inputPerM: 0, outputPerM: 0 };
  return prices[`${provider}:${model}`];
}

/** Estimated cost of one attempt, or null when the model has no price or reported no usage. */
export function attemptCostUsd(provider: string, model: string, usage: PricedUsage | undefined, at?: Date): number | null {
  const price = priceFor(provider, model);
  if (!price || !usage) return null;
  return estimateCostUsd(usage, price, at);
}
