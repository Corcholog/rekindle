import { describe, it, expect, afterEach } from 'vitest';
import { getLogger, logger, setLogSink, formatPretty, serializeError, REDACTED } from '../src/observability/logger';

const SENTINEL = 'SENTINEL-7f3a-texto-privado';

function capture() {
  const lines: string[] = [];
  const restore = setLogSink({ write: (line) => { lines.push(line); } });
  const previousLevel = logger.level;
  logger.level = 'debug';
  return {
    lines,
    restore: () => { restore(); logger.level = previousLevel; },
  };
}

describe('Structured logger redaction', () => {
  let cap: ReturnType<typeof capture>;
  afterEach(() => cap?.restore());

  it('censors sensitive fields at any depth and keeps IDs and numbers', () => {
    cap = capture();
    const log = getLogger('test');
    log.info({
      contentId: 'c-1', durationMs: 42,
      text: SENTINEL, prompt: SENTINEL, url: `https://example.com/${SENTINEL}`, notePath: `${SENTINEL}.md`,
      candidates: [{ projectId: 'p-1', distance: 0.4, noteTitle: SENTINEL }],
      nested: { deeper: { summary: SENTINEL, rawText: SENTINEL } },
    }, 'Stage finished');

    const out = cap.lines.join('');
    expect(out).not.toContain(SENTINEL);
    const rec = JSON.parse(cap.lines[0]);
    expect(rec).toMatchObject({ component: 'test', contentId: 'c-1', durationMs: 42, text: REDACTED, msg: 'Stage finished' });
    expect(rec.candidates[0]).toEqual({ projectId: 'p-1', distance: 0.4, noteTitle: REDACTED });
  });

  it('logs errors without their message or stack', () => {
    cap = capture();
    const err = Object.assign(new Error(`Model said: ${SENTINEL}`), { kind: 'invalid_json', status: 502 });
    getLogger('ai').warn({ err, attempt: 1 }, 'Provider attempt failed');
    getLogger('ai').error({ cause: new TypeError(SENTINEL) }, 'Nested error');

    const out = cap.lines.join('');
    expect(out).not.toContain(SENTINEL);
    expect(JSON.parse(cap.lines[0]).err).toEqual({ type: 'Error', kind: 'invalid_json', status: 502 });
    expect(JSON.parse(cap.lines[1]).cause).toEqual({ type: 'TypeError' });
  });

  it('keeps safe error codes only', () => {
    const e = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(serializeError(e)).toEqual({ type: 'Error', code: 'ECONNREFUSED' });
    expect(serializeError(Object.assign(new Error('x'), { code: `bad ${SENTINEL}` }))).toEqual({ type: 'Error' });
    expect(serializeError('just a string')).toEqual({ type: 'string' });
  });

  it('formats a readable terminal line', () => {
    const line = formatPretty(JSON.stringify({ level: 30, time: 0, component: 'evaluator', msg: 'Done', contentId: 'c-1', n: 3 }));
    expect(line).toMatch(/INFO +\[evaluator\] Done contentId=c-1 n=3\n$/);
  });
});
