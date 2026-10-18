import { OllamaEmbeddings } from '@langchain/ollama';
import { z } from 'zod';
import { env } from '../config';
import { Attempt, CompletionOptions, Usage } from './types';
import { buildProviderChain, runChain } from './chain';

export interface EvaluationOutput<T> {
  data: T;
  model: string;
  usage?: Usage;
  latencyMs?: number;
  attempts?: Attempt[];
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
      console.error('[AI Provider] Error fetching local embedding from Ollama:', error);
      throw error;
    }
  }

  /** Evalúa contenido y fuerza la salida a cumplir con un esquema Zod. */
  async evaluateContent<T extends z.ZodTypeAny>(
    systemPrompt: string,
    userText: string,
    schema: T,
    options?: CompletionOptions,
  ): Promise<EvaluationOutput<z.infer<T>>> {
    if (this.overrides.evaluate) return this.overrides.evaluate(systemPrompt, userText, schema, options);
    // Read at call time so the key and chain can change without restarting
    const providers = buildProviderChain({ ...process.env, OLLAMA_URL: this.baseUrl });
    const result = await runChain(providers, systemPrompt, userText, schema, options);
    this.lastUsedModel = result.model;
    return result;
  }
}

export const sharedAiProvider = new AiProvider();
