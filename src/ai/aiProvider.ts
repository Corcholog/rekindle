import { OllamaEmbeddings } from '@langchain/ollama';
import { z } from 'zod';
import { env } from '../config';
import { Attempt, CompletionOptions, Usage } from './types';
import { buildProviderChain, ChainError, runChain } from './chain';
import { LlmCallContext, recordLlmCall } from '../observability/llmTelemetry';
import { getLogger } from '../observability/logger';

const log = getLogger('ai');

export interface EvaluationOutput<T> {
  data: T;
  model: string;
  usage?: Usage;
  latencyMs?: number;
  attempts?: Attempt[];
  /** llm_telemetry rows written for this call (only when a call context was given). */
  telemetryIds?: string[];
}

/**
 * Single entry point for model calls: structured completions go through the provider chain
 * (LLM_PROVIDERS, default gemini -> ollama); embeddings are ALWAYS local with Ollama (I3).
 */
export type EvaluateFn = (
  system: string,
  user: string,
  schema: z.ZodTypeAny,
  options?: CompletionOptions,
) => Promise<EvaluationOutput<any>>;

export class AiProvider {
  private embedder: OllamaEmbeddings;
  private overrides: { evaluate?: EvaluateFn; embed?: (text: string) => Promise<number[]> } = {};
  public lastUsedModel: string = 'unknown';

  constructor(
    private baseUrl: string = env.OLLAMA_URL,
    embeddingModel: string = env.EMBED_MODEL,
  ) {
    this.embedder = new OllamaEmbeddings({
      baseUrl: this.baseUrl,
      model: embeddingModel,
      maxRetries: 3,
    });
  }

  /**
   * Replaces the model calls. Used by the eval harness to record/replay LLM responses and cache
   * embeddings while the real evaluator, reconciler and prompts run unchanged.
   */
  setOverrides(overrides: { evaluate?: EvaluateFn; embed?: (text: string) => Promise<number[]> }): void {
    this.overrides = overrides;
  }

  /** Obtiene el embedding (vector 1024D) con el modelo local de Ollama (bge-m3). */
  async getEmbedding(text: string): Promise<number[]> {
    if (this.overrides.embed) return this.overrides.embed(text);
    try {
      return await this.embedder.embedQuery(text);
    } catch (error) {
      log.error({ err: error, chars: text.length }, 'Local embedding with Ollama failed');
      throw error;
    }
  }

  /**
   * Evalúa contenido y fuerza la salida a cumplir con un esquema Zod. With a call context, every
   * provider attempt (including failures) is recorded in llm_telemetry.
   */
  async evaluateContent<T extends z.ZodTypeAny>(
    systemPrompt: string,
    userText: string,
    schema: T,
    options?: CompletionOptions,
    ctx?: LlmCallContext,
  ): Promise<EvaluationOutput<z.infer<T>>> {
    let result: EvaluationOutput<z.infer<T>>;
    const started = Date.now();
    try {
      if (this.overrides.evaluate) {
        result = await this.overrides.evaluate(systemPrompt, userText, schema, options);
      } else {
        // Read at call time so the key and chain can change without restarting
        const providers = buildProviderChain({ ...process.env, OLLAMA_URL: this.baseUrl });
        result = await runChain(providers, systemPrompt, userText, schema, options);
      }
    } catch (err) {
      if (ctx) {
        const attempts: Attempt[] = err instanceof ChainError
          ? err.attempts
          : [{ provider: 'unknown', model: 'unknown', ok: false, errorKind: 'other', latencyMs: Date.now() - started }];
        await recordLlmCall(ctx, systemPrompt, userText, attempts);
      }
      throw err;
    }
    this.lastUsedModel = result.model;
    if (ctx) {
      const attempts = result.attempts?.length ? result.attempts : [attemptFromModel(result, Date.now() - started)];
      result.telemetryIds = await recordLlmCall(ctx, systemPrompt, userText, attempts, result.data);
    }
    return result;
  }
}

// Results without attempt details (for example a test double) still get one telemetry row
function attemptFromModel(result: EvaluationOutput<unknown>, elapsedMs: number): Attempt {
  const [provider, ...rest] = result.model.split(':');
  return {
    provider: rest.length > 0 ? provider : 'unknown',
    model: rest.length > 0 ? rest.join(':') : result.model,
    ok: true,
    usage: result.usage,
    latencyMs: result.latencyMs ?? elapsedMs,
  };
}

export const sharedAiProvider = new AiProvider();
