import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { env } from '../config';

export interface EvaluationOutput<T> {
  data: T;
  model: string;
}

export class OllamaProvider {
  private embedder: OllamaEmbeddings;
  private chatModel: ChatOllama;
  private geminiClient?: GoogleGenAI;
  public lastUsedModel: string = 'unknown';

  constructor(
    private baseUrl: string = env.OLLAMA_URL,
    embeddingModel: string = env.EMBED_MODEL,
    chatModelName: string = 'qwen2.5:7b-instruct'
  ) {
    // Embeddings are ALWAYS local with Ollama (bge-m3)
    this.embedder = new OllamaEmbeddings({
      baseUrl: this.baseUrl,
      model: embeddingModel,
      maxRetries: 3,
    });

    this.chatModel = new ChatOllama({
      baseUrl: this.baseUrl,
      model: chatModelName,
      maxRetries: 3,
      temperature: 0.1,
      numCtx: 16384, // Explicit 16k context window so system prompt is never truncated
    });
  }

  private getGeminiClient(): GoogleGenAI | undefined {
    const key = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (key) {
      if (!this.geminiClient) {
        this.geminiClient = new GoogleGenAI({ apiKey: key });
      }
      return this.geminiClient;
    }
    return undefined;
  }

  /**
   * Obtiene el embedding (vector 1024D) de un texto utilizando EXCLUSIVAMENTE
   * el modelo local de Ollama (bge-m3), ahorrando cuota y rate-limits del LLM.
   */
  async getEmbedding(text: string): Promise<number[]> {
    try {
      const vector = await this.embedder.embedQuery(text);
      return vector;
    } catch (error) {
      console.error('[AI Provider] Error fetching local embedding from Ollama:', error);
      throw error;
    }
  }


  /**
   * Evalúa contenido y fuerza la salida a cumplir con un esquema Zod.
   * Utiliza Gemini si GEMINI_API_KEY está presente, o ChatOllama local como fallback.
   */
  async evaluateContent<T extends z.ZodTypeAny>(
    systemPrompt: string,
    userText: string,
    schema: T
  ): Promise<EvaluationOutput<z.infer<T>>> {
    const gemini = this.getGeminiClient();
    if (gemini) {
      const modelName = process.env.GEMINI_MODEL || env.CHAT_MODEL || 'gemini-3.1-flash-lite';
      try {
        const rawSchema = z.toJSONSchema(schema) as any;
        let responseSchema = rawSchema;
        if (rawSchema && typeof rawSchema === 'object') {
          const { $schema: _schema, ...rest } = rawSchema;
          responseSchema = rest;
        }

        const res = await gemini.models.generateContent({
          model: modelName,
          contents: userText,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json',
            responseJsonSchema: responseSchema,
            temperature: 0.1,
          },
        });

        let text = res.text?.trim() || '{}';
        if (text.startsWith('```json')) {
          text = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (text.startsWith('```')) {
          text = text.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }

        const parsedJson = JSON.parse(text);
        const validated = schema.parse(parsedJson);
        const fullModel = `gemini:${modelName}`;
        this.lastUsedModel = fullModel;
        return { data: validated, model: fullModel };
      } catch (geminiError) {
        console.warn(`[AI Provider] Gemini (${modelName}) evaluation failed, falling back to local Ollama:`, geminiError);
      }
    }

    try {
      const modelWithStructure = this.chatModel.withStructuredOutput(schema, {
        name: 'EvaluationResult'
      });

      const response = await modelWithStructure.invoke([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ]);

      const fullModel = `ollama:${this.chatModel.model}`;
      this.lastUsedModel = fullModel;
      return { data: response as z.infer<T>, model: fullModel };
    } catch (error) {
      console.error('[AI Provider] Error in structured evaluation with Ollama:', error);
      throw error;
    }
  }
}

export { OllamaProvider as AiProvider };
export const sharedAiProvider = new OllamaProvider();

