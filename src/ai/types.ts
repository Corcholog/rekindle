import { z } from 'zod';

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  /** Part of promptTokens served from the provider's prompt cache (billed cheaper). */
  cachedPromptTokens?: number;
  /** Part of completionTokens spent thinking (DeepSeek thinking mode). */
  reasoningTokens?: number;
}

/** unavailable = the provider's servers are overloaded or down (HTTP 5xx); transient, unlike a spent quota. */
export type ErrorKind = 'timeout' | 'http' | 'rate_limit' | 'unavailable' | 'empty' | 'invalid_json' | 'schema' | 'other';

/** Malformed model output is worth one retry; transport errors go straight to the next provider. */
export const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set(['empty', 'invalid_json', 'schema']);

/**
 * What was wrong with an answer that did not parse, without any of its text, so logs and telemetry
 * can say why a model fails without storing what it wrote.
 */
export interface MalformedAnswer {
  chars: number;
  startsWithBrace: boolean;
  endsWithBrace: boolean;
  fenced: boolean;
  /** How JSON.parse failed (its message quotes the text, so only the kind is kept). */
  parseError: 'unterminated_string' | 'unexpected_end' | 'expected_delimiter' | 'expected_property' | 'bad_escape' | 'bad_control_character' | 'unexpected_token' | 'other';
  /** Where it failed, as a share of the answer from 0 to 1, and what kind of character was there. */
  errorAt: number | null;
  errorChar: 'quote' | 'newline' | 'backslash' | 'control' | 'brace' | 'letter' | 'other' | 'end' | null;
  /** Why the provider stopped writing ("stop", "length"…), when it says. */
  finishReason?: string;
}

export interface ProviderErrorDetails {
  /** How long the provider asked us to wait (rate_limit). */
  retryAfterMs?: number;
  /** The quota is spent for the day (or longer): waiting a few seconds will not help. */
  quotaExhausted?: boolean;
  /** invalid_json: what was wrong with the answer, text-free. */
  malformed?: MalformedAnswer;
}

export class ProviderError extends Error {
  retryAfterMs?: number;
  quotaExhausted?: boolean;
  malformed?: MalformedAnswer;

  constructor(public kind: ErrorKind, message: string, details: ProviderErrorDetails = {}) {
    super(message);
    this.retryAfterMs = details.retryAfterMs;
    this.quotaExhausted = details.quotaExhausted;
    this.malformed = details.malformed;
  }
}

export interface CompletionOptions {
  /** DeepSeek only: enable the model's thinking mode (default off). */
  thinking?: boolean;
}

export interface Completion<T> {
  data: T;
  usage?: Usage;
  /** The answer was not valid JSON but was repaired (repairModelJson): what was fixed. */
  repaired?: string[];
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
  /** When the attempt started (ISO 8601); prices can depend on the hour. */
  startedAt?: string;
  /** Time slept after this attempt before retrying (rate limits). */
  waitedMs?: number;
  /** invalid_json: what was wrong with the answer, text-free. */
  malformed?: MalformedAnswer;
  /** An answer that parsed only after a repair: what was fixed. */
  repaired?: string[];
}

export interface JsonSchemaLike {
  [key: string]: unknown;
}

/** Zod -> JSON Schema without the $schema marker, which providers reject or ignore. */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchemaLike {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as JsonSchemaLike;
  return rest;
}

const PARSE_ERRORS: Array<[RegExp, MalformedAnswer['parseError']]> = [
  [/Unterminated string/i, 'unterminated_string'],
  [/Unexpected end of JSON input/i, 'unexpected_end'],
  [/Expected ',' or|Expected ':'|after (?:property value|array element)/i, 'expected_delimiter'],
  [/Expected double-quoted property name/i, 'expected_property'],
  [/Bad escaped character|Bad Unicode escape/i, 'bad_escape'],
  [/Bad control character/i, 'bad_control_character'],
  [/Unexpected (?:token|non-whitespace character)/i, 'unexpected_token'],
];

function charKind(c: string | undefined): MalformedAnswer['errorChar'] {
  if (c === undefined) return 'end';
  if (c === '"') return 'quote';
  if (c === '\n' || c === '\r') return 'newline';
  if (c === '\\') return 'backslash';
  if (c.charCodeAt(0) < 32) return 'control';
  if ('{}[]'.includes(c)) return 'brace';
  if (/\p{L}/u.test(c)) return 'letter';
  return 'other';
}

/** Describes why `text` is not JSON from the parser's error, keeping none of the text. */
export function describeMalformed(text: string, error: unknown, finishReason?: string): MalformedAnswer {
  const message = error instanceof Error ? error.message : '';
  const position = /at position (\d+)/.exec(message);
  const at = position ? Number(position[1]) : null;
  const parseError = PARSE_ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? 'other';
  const trimmed = text.trim();
  return {
    chars: text.length,
    startsWithBrace: trimmed.startsWith('{'),
    endsWithBrace: trimmed.endsWith('}'),
    fenced: /^```/.test(trimmed),
    parseError,
    errorAt: at === null ? (parseError === 'unexpected_end' ? 1 : null) : Math.round((at / Math.max(1, text.length)) * 100) / 100,
    errorChar: at === null ? (parseError === 'unexpected_end' ? 'end' : null) : charKind(text[at]),
    ...(finishReason ? { finishReason } : {}),
  };
}

/** The object schema behind optional/nullable wrappers, or null. */
function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  let current: any = schema;
  for (let i = 0; i < 4 && current; i++) {
    if (current.shape && typeof current.shape === 'object') return current.shape;
    current = typeof current.unwrap === 'function' ? current.unwrap() : null;
  }
  return null;
}

/**
 * One slip DeepSeek makes with a nested list: it closes an inner object early, writes that object's
 * remaining fields at the top level and then the brace it skipped, so the answer ends with one "}"
 * too many (all 6 failures in a diagnostic run, docs/JOURNEY.md). Only that shape is repaired: the
 * text must parse once a single trailing "}" is dropped, and a top-level field moves back into an
 * inner object only if the schema has it there, not at the top, and the inner object lacks it.
 * The result still goes through the schema; anything else stays invalid.
 */
export function repairModelJson(text: string, schema: z.ZodTypeAny): { value: unknown; repaired: string[] } | null {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('}')) return null;
  let value: any;
  try {
    value = JSON.parse(trimmed.slice(0, -1));
  } catch {
    return null;
  }
  const repaired = ['extra_closing_brace'];
  const shape = objectShape(schema);
  if (shape && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (key in shape) continue;
      const home = Object.entries(shape).find(([name, child]) => {
        const inner = value[name];
        const childShape = objectShape(child);
        return childShape && key in childShape && inner && typeof inner === 'object' && !Array.isArray(inner) && !(key in inner);
      });
      if (!home) continue;
      value[home[0]][key] = value[key];
      delete value[key];
      repaired.push(`moved:${home[0]}.${key}`);
    }
  }
  return { value, repaired };
}

/** Parses model text as JSON (tolerating a code fence) and validates it against the schema. */
export function parseModelJson<S extends z.ZodTypeAny>(
  text: string | null | undefined,
  schema: S,
  info: { finishReason?: string; onRepair?: (repaired: string[]) => void } = {},
): z.infer<S> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new ProviderError('empty', 'La respuesta del modelo llegó vacía');

  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (error) {
    const malformed = describeMalformed(unfenced, error, info.finishReason);
    const fixed = malformed.parseError === 'unexpected_token' ? repairModelJson(unfenced, schema) : null;
    const checked = fixed ? schema.safeParse(fixed.value) : null;
    if (fixed && checked?.success) {
      info.onRepair?.(fixed.repaired);
      return checked.data;
    }
    throw new ProviderError('invalid_json', 'La respuesta del modelo no es JSON válido', { malformed });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ProviderError('schema', 'La respuesta del modelo no cumple el esquema esperado');
  }
  return result.data;
}
