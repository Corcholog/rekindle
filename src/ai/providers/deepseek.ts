import { z } from 'zod';
import { ChatProvider, Completion, CompletionOptions, ProviderError, Usage, parseModelJson, toJsonSchema } from '../types';

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

/**
 * DeepSeek through its OpenAI-compatible API. JSON mode only guarantees valid JSON, not the
 * schema, so the schema is described in the prompt and the reply is validated here.
 * Thinking is ON by default at DeepSeek, so every request states the mode explicitly.
 */
export class DeepSeekProvider implements ChatProvider {
  readonly name = 'deepseek';
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxTokens: number;

  constructor(options: DeepSeekOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'deepseek-flash';
    this.baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxTokens = options.maxTokens ?? 8192;
  }

  async complete<S extends z.ZodTypeAny>(
    system: string,
    user: string,
    schema: S,
    options: CompletionOptions = {},
  ): Promise<Completion<z.infer<S>>> {
    const thinking = options.thinking === true;
    // JSON mode requires the word "json" in the prompt; an example of the shape helps.
    const systemWithSchema = `${system}\n\nResponde únicamente con un objeto json válido que cumpla este esquema JSON, sin texto adicional:\n${JSON.stringify(toJsonSchema(schema))}`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: systemWithSchema },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      thinking: { type: thinking ? 'enabled' : 'disabled' },
      max_tokens: this.maxTokens,
      stream: false,
    };
    // Thinking mode ignores sampling parameters
    if (!thinking) body.temperature = 0.1;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: any) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new ProviderError(timedOut ? 'timeout' : 'http', timedOut ? 'DeepSeek no respondió a tiempo' : 'No se pudo conectar con DeepSeek');
    }

    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new ProviderError('rate_limit', 'DeepSeek alcanzó su límite de peticiones', {
        retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
      });
    }

    if (response.status >= 500) {
      throw new ProviderError('unavailable', `DeepSeek no está disponible (HTTP ${response.status})`);
    }

    if (!response.ok) {
      // Status only: the response body is not logged or propagated
      throw new ProviderError('http', `DeepSeek respondió HTTP ${response.status}`);
    }

    const payload: any = await response.json().catch(() => null);
    const data = parseModelJson(payload?.choices?.[0]?.message?.content, schema);
    return { data, usage: deepSeekUsage(payload?.usage) };
  }
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Token counts from a DeepSeek response, including cache hits and thinking tokens when reported. */
export function deepSeekUsage(raw: any): Usage | undefined {
  if (!raw) return undefined;
  const usage: Usage = { promptTokens: count(raw.prompt_tokens), completionTokens: count(raw.completion_tokens) };
  const cached = count(raw.prompt_cache_hit_tokens);
  const reasoning = count(raw.completion_tokens_details?.reasoning_tokens);
  if (cached !== undefined) usage.cachedPromptTokens = cached;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}
