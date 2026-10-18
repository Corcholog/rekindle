import { z } from 'zod';
import {
  Attempt, ChatProvider, CompletionOptions, ErrorKind, ProviderError, RETRYABLE_KINDS, Usage,
} from './types';
import { DeepSeekProvider } from './providers/deepseek';
import { GeminiProvider } from './providers/gemini';
import { OllamaChatProvider } from './providers/ollama';

export const PROVIDER_NAMES = ['deepseek', 'gemini', 'ollama'] as const;
export const DEFAULT_PROVIDERS = 'gemini,ollama';

export interface ChainResult<T> {
  data: T;
  /** "<provider>:<model>" of the provider that answered. */
  model: string;
  usage?: Usage;
  latencyMs: number;
  attempts: Attempt[];
}

export class ChainError extends Error {
  /** The chain stopped because of rate limiting (waiting did not help). */
  rateLimited = false;
  /** A quota that resets later (for example daily) is spent. */
  quotaExhausted = false;

  constructor(message: string, public attempts: Attempt[]) {
    super(message);
  }
}

export interface RateLimitPolicy {
  /**
   * fallback (production): a rate limit moves on to the next provider.
   * wait (evals): sleep and retry the same provider; give up without falling back, so results
   * are never silently produced by a different model.
   */
  onRateLimit: 'fallback' | 'wait';
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Tries each provider in order. Malformed output (empty, invalid JSON, schema mismatch) is
 * retried once on the same provider; any other failure moves on to the next one.
 */
export async function runChain<S extends z.ZodTypeAny>(
  providers: ChatProvider[],
  system: string,
  user: string,
  schema: S,
  options?: CompletionOptions,
  policy?: RateLimitPolicy,
): Promise<ChainResult<z.infer<S>>> {
  const attempts: Attempt[] = [];
  const sleep = policy?.sleep ?? defaultSleep;

  for (const provider of providers) {
    let malformedTries = 0;
    let rateLimitRetries = 0;
    for (;;) {
      const started = Date.now();
      try {
        const { data, usage } = await provider.complete(system, user, schema, options);
        const latencyMs = Date.now() - started;
        attempts.push({ provider: provider.name, model: provider.model, ok: true, usage, latencyMs });
        return { data, model: `${provider.name}:${provider.model}`, usage, latencyMs, attempts };
      } catch (err) {
        const kind: ErrorKind = err instanceof ProviderError ? err.kind : 'other';
        const attempt: Attempt = { provider: provider.name, model: provider.model, ok: false, errorKind: kind, latencyMs: Date.now() - started };
        attempts.push(attempt);
        console.warn(`[AI] ${provider.name}:${provider.model} falló (${kind}): ${err instanceof Error ? err.message : 'error desconocido'}`);

        if (kind === 'rate_limit' && policy?.onRateLimit === 'wait') {
          const quotaExhausted = err instanceof ProviderError && err.quotaExhausted === true;
          if (quotaExhausted || rateLimitRetries >= policy.maxRetries) {
            const failure = new ChainError(quotaExhausted ? 'Cuota agotada en el proveedor de IA' : 'Límite de peticiones del proveedor de IA', attempts);
            failure.rateLimited = true;
            failure.quotaExhausted = quotaExhausted;
            throw failure;
          }
          const suggested = err instanceof ProviderError ? err.retryAfterMs : undefined;
          const delay = Math.min(suggested ?? policy.baseDelayMs * 2 ** rateLimitRetries, policy.maxDelayMs);
          attempt.waitedMs = delay;
          rateLimitRetries++;
          await sleep(delay);
          continue;
        }

        if (RETRYABLE_KINDS.has(kind) && malformedTries++ < 1) continue;
        break; // next provider
      }
    }
  }

  throw new ChainError('Ningún proveedor de IA pudo responder', attempts);
}

export interface ProviderEnv {
  LLM_PROVIDERS?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  CHAT_MODEL?: string;
  OLLAMA_URL?: string;
  OLLAMA_CHAT_MODEL?: string;
}

/** Builds the ordered provider list; providers that need a key are skipped when it is missing. */
export function buildProviderChain(env: ProviderEnv): ChatProvider[] {
  const names = (env.LLM_PROVIDERS || DEFAULT_PROVIDERS).split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter(n => !(PROVIDER_NAMES as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new Error(`LLM_PROVIDERS contiene proveedores desconocidos: ${unknown.join(', ')}`);
  }

  const providers: ChatProvider[] = [];
  for (const name of names) {
    if (name === 'deepseek' && env.DEEPSEEK_API_KEY) {
      providers.push(new DeepSeekProvider({ apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL || undefined, baseUrl: env.DEEPSEEK_BASE_URL || undefined }));
    } else if (name === 'gemini' && env.GEMINI_API_KEY) {
      providers.push(new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || env.CHAT_MODEL || undefined }));
    } else if (name === 'ollama') {
      providers.push(new OllamaChatProvider({ baseUrl: env.OLLAMA_URL || 'http://127.0.0.1:11434', model: env.OLLAMA_CHAT_MODEL || undefined }));
    }
  }
  return providers;
}
