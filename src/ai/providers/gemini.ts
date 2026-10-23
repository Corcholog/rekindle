import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { ChatProvider, Completion, ProviderError, parseModelJson, toJsonSchema } from '../types';
import { dumpFailedAnswer } from '../debugDump';

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
      const message = String(err?.message ?? '');
      if (err?.status === 429 || /RESOURCE_EXHAUSTED|\b429\b/.test(message)) {
        const delay = message.match(/retry(?:Delay)?\D{0,12}?(\d+(?:\.\d+)?)\s*s/i);
        throw new ProviderError('rate_limit', 'Gemini alcanzó su límite de peticiones', {
          retryAfterMs: delay ? Math.ceil(Number(delay[1]) * 1000) : undefined,
          quotaExhausted: /PerDay|per day|daily/i.test(message),
        });
      }
      const status = Number(err?.status);
      if (status >= 500 || /UNAVAILABLE|high demand/i.test(message)) {
        throw new ProviderError('unavailable', `Gemini no está disponible (HTTP ${err?.status ?? '?'}): ${message.slice(0, 200)}`);
      }
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      // Google's error bodies describe the problem (model, quota, safety) and carry no credentials
      throw new ProviderError(timedOut ? 'timeout' : 'http', timedOut
        ? 'Gemini no respondió a tiempo'
        : `Gemini devolvió un error (HTTP ${err?.status ?? '?'}): ${message.slice(0, 300)}`);
    }

    let data: z.infer<S>;
    try {
      data = parseModelJson(res.text, schema, { finishReason: res.candidates?.[0]?.finishReason ?? undefined });
    } catch (err) {
      await dumpFailedAnswer('gemini', this.model, err, res.text);
      throw err;
    }
    const meta = res.usageMetadata;
    const usage = meta ? { promptTokens: meta.promptTokenCount, completionTokens: meta.candidatesTokenCount } : undefined;
    return { data, usage };
  }
}
