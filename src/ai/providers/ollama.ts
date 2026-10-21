import { ChatOllama } from '@langchain/ollama';
import { z } from 'zod';
import { ChatProvider, Completion, ProviderError } from '../types';

// The local Ollama client keeps the fetch captured when the module loads, so code that
// replaces globalThis.fetch later (for example tests faking web pages) cannot intercept it.
const localFetch = globalThis.fetch;

export interface OllamaChatOptions {
  baseUrl: string;
  model?: string;
}

export class OllamaChatProvider implements ChatProvider {
  readonly name = 'ollama';
  readonly model: string;
  private chat: ChatOllama;

  constructor(options: OllamaChatOptions) {
    this.model = options.model ?? 'qwen2.5:7b-instruct';
    this.chat = new ChatOllama({
      baseUrl: options.baseUrl,
      model: this.model,
      maxRetries: 3,
      temperature: 0.1,
      numCtx: 32768, // 32k tokens: a full notes budget (NOTES_CONTEXT_CHARS) plus the summary and instructions fit
      fetch: localFetch,
    });
  }

  async complete<S extends z.ZodTypeAny>(system: string, user: string, schema: S): Promise<Completion<z.infer<S>>> {
    let response: unknown;
    try {
      response = await this.chat.withStructuredOutput(schema, { name: 'EvaluationResult' }).invoke([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);
    } catch (err: any) {
      // Local server: its error text carries no secrets and explains most failures (missing model, OOM)
      throw new ProviderError('http', `Ollama devolvió un error: ${String(err?.message ?? err).slice(0, 200)}`);
    }

    const checked = schema.safeParse(response);
    if (!checked.success) throw new ProviderError('schema', 'La respuesta de Ollama no cumple el esquema esperado');
    // Token counts are not exposed by the structured-output call; local inference costs nothing
    return { data: checked.data };
  }
}
