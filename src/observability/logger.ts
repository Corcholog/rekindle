import pino from 'pino';

// Structured logger for the whole server (Phase 4). Log calls carry IDs, counts, lengths and
// durations. Fields that could hold note text, article text, prompts, model output or browsing
// history are censored at any depth, and errors keep only their name, kind and status: an error
// message can quote model output or a URL.

export const REDACTED = '[redacted]';

const SENSITIVE_KEYS = new Set([
  'text', 'rawtext', 'prompt', 'system', 'user', 'content', 'summary', 'output', 'response',
  'url', 'uri', 'title', 'notepath', 'notetitle', 'thesis', 'snippet', 'observation',
  'suggestedaction', 'reasoning', 'body', 'query', 'filepath', 'path', 'message', 'stack',
]);

export interface SafeError {
  type: string;
  kind?: string;
  status?: number;
  code?: string;
}

export function serializeError(err: unknown): SafeError {
  if (!(err instanceof Error)) return { type: typeof err };
  const e = err as Error & { kind?: unknown; status?: unknown; statusCode?: unknown; code?: unknown };
  const out: SafeError = { type: e.name || e.constructor?.name || 'Error' };
  if (typeof e.kind === 'string') out.kind = e.kind;
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (status !== undefined) out.status = status;
  if (typeof e.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(e.code)) out.code = e.code;
  return out;
}

export function sanitizeLogObject(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return serializeError(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.map(v => sanitizeLogObject(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : sanitizeLogObject(v, depth + 1);
  }
  return out;
}

export interface LogSink { write(line: string): void }

const LEVEL_NAMES: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };

// One readable line per record for a terminal: "12:00:01 INFO  [evaluator] msg key=value"
export function formatPretty(line: string): string {
  let rec: Record<string, unknown>;
  try { rec = JSON.parse(line); } catch { return line; }
  const { level, time, msg, component, pid: _pid, hostname: _host, ...fields } = rec;
  const clock = new Date(Number(time)).toTimeString().slice(0, 8);
  const extra = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  const tag = component ? ` [${component}]` : '';
  return `${clock} ${(LEVEL_NAMES[Number(level)] ?? String(level)).padEnd(5)}${tag} ${msg ?? ''}${extra ? ` ${extra}` : ''}\n`;
}

const stdoutSink: LogSink = { write: (line) => { process.stdout.write(line); } };
let currentSink: LogSink = stdoutSink;

const pretty = (process.env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'pretty')) === 'pretty';
const destination = {
  write(line: string) {
    currentSink.write(pretty && currentSink === stdoutSink ? formatPretty(line) : line);
  },
};

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: undefined,
  serializers: { err: (err: unknown) => (err instanceof Error ? serializeError(err) : err) },
  formatters: { log: (obj) => sanitizeLogObject(obj) as Record<string, unknown> },
}, destination);

export function getLogger(component: string) {
  return logger.child({ component });
}

// Tests capture the raw JSON lines; returns a function that restores the previous sink.
export function setLogSink(sink: LogSink | null): () => void {
  const previous = currentSink;
  currentSink = sink ?? stdoutSink;
  return () => { currentSink = previous; };
}
