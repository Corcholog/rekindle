import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { ChatProvider, Completion, ProviderError, parseModelJson, toJsonSchema } from '../types';

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export class GeminiProvider implements ChatProvider {
  readonly name = 'gemini';
  readonly model: string;
  private client: GoogleGenAI;
  private timeoutMs: number;

  constructor(options: GeminiOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model ?? 'gemini-3.1-flash-lite';
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async complete<S extends z.ZodTypeAny>(system: string, user: string, schema: S): Promise<Completion<z.infer<S>>> {
    let res;
    try {
      res = await this.client.models.generateContent({
        model: this.model,
        contents: user,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseJsonSchema: toJsonSchema(schema),
          temperature: 0.1,
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        },
      });
    } catch (err: any) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new ProviderError(timedOut ? 'timeout' : 'http', timedOut ? 'Gemini no respondió a tiempo' : 'Gemini devolvió un error');
    }

    const data = parseModelJson(res.text, schema);
    const meta = res.usageMetadata;
    const usage = meta ? { promptTokens: meta.promptTokenCount, completionTokens: meta.candidatesTokenCount } : undefined;
    return { data, usage };
  }
}
