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
export class AiProvider {
  private embedder: OllamaEmbeddings;
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

  /** Obtiene el embedding (vector 1024D) con el modelo local de Ollama (bge-m3). */
  async getEmbedding(text: string): Promise<number[]> {
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
    // Read at call time so the key and chain can change without restarting
    const providers = buildProviderChain({ ...process.env, OLLAMA_URL: this.baseUrl });
    const result = await runChain(providers, systemPrompt, userText, schema, options);
    this.lastUsedModel = result.model;
    return result;
  }
}

export const sharedAiProvider = new AiProvider();
