import { z } from 'zod';

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
}

export type ErrorKind = 'timeout' | 'http' | 'empty' | 'invalid_json' | 'schema' | 'other';

/** Malformed model output is worth one retry; transport errors go straight to the next provider. */
export const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set(['empty', 'invalid_json', 'schema']);

export class ProviderError extends Error {
  constructor(public kind: ErrorKind, message: string) {
    super(message);
  }
}

export interface CompletionOptions {
  /** DeepSeek only: enable the model's thinking mode (default off). */
  thinking?: boolean;
}

export interface Completion<T> {
  data: T;
  usage?: Usage;
}

export interface ChatProvider {
  /** Short id used in logs and `llm_telemetry.model_name`, e.g. "deepseek". */
  readonly name: string;
  readonly model: string;
  complete<S extends z.ZodTypeAny>(
    system: string,
    user: string,
    schema: S,
    options?: CompletionOptions,
  ): Promise<Completion<z.infer<S>>>;
}

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  errorKind?: ErrorKind;
  usage?: Usage;
  latencyMs: number;
}

export interface JsonSchemaLike {
  [key: string]: unknown;
}

/** Zod -> JSON Schema without the $schema marker, which providers reject or ignore. */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchemaLike {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as JsonSchemaLike;
  return rest;
}

/** Parses model text as JSON (tolerating a code fence) and validates it against the schema. */
export function parseModelJson<S extends z.ZodTypeAny>(text: string | null | undefined, schema: S): z.infer<S> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new ProviderError('empty', 'La respuesta del modelo llegó vacía');

  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new ProviderError('invalid_json', 'La respuesta del modelo no es JSON válido');
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ProviderError('schema', 'La respuesta del modelo no cumple el esquema esperado');
  }
  return result.data;
}
