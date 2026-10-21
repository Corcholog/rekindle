import { createHash } from 'crypto';
import type { AiProvider } from '../../src/ai/aiProvider';

// Deterministic stand-ins for Ollama and the LLM chain, installed through
// AiProvider.setOverrides(). Import the provider only after stubbing DATABASE_URL: it reaches
// src/db, which binds its pool on first import.

const DIMENSIONS = 1024;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3);
}

/**
 * Hashed bag of words, L2-normalized: identical texts give identical vectors, texts that share
 * words are close, unrelated texts are nearly orthogonal (cosine distance about 1).
 */
export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of tokens(text)) {
    const digest = createHash('sha256').update(token).digest();
    const index = digest.readUInt16BE(0) % DIMENSIONS;
    vector[index] += digest[2] & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map(v => v / norm);
}

export interface FakeCall {
  system: string;
  user: string;
  kind: 'summary' | 'triage' | 'other';
}

type Answer = unknown | ((call: FakeCall) => unknown);

/** Default answers for the two pipeline schemas; anything else must be scripted with `answerNext`. */
function defaultAnswer(call: FakeCall): unknown {
  if (call.kind === 'summary') return { summary: `Resumen simulado: ${call.user.slice(0, 200)}` };
  if (call.kind === 'triage') {
    return { verdict: 'irrelevant', confidenceScore: 0.1, triageReasoning: 'Respuesta simulada: sin relación.', action: null };
  }
  throw new Error('fakeAi: no scripted answer for this schema; use answerNext()');
}

export interface FakeAi {
  calls: FakeCall[];
  embeddings: string[];
  /** Answers for the next LLM calls, in order. A function receives the call; an Error is thrown. */
  answerNext(...answers: Answer[]): void;
  /**
   * The second call that lays out a suggestion's text (src/evaluator/structureText.ts) has its own
   * queue and list, so scripted triage answers and call counts are unaffected. Unscripted, it fails
   * and the suggestion keeps its plain text.
   */
  structureCalls: FakeCall[];
  answerStructureNext(...answers: Answer[]): void;
  uninstall(): void;
}

export function installFakeAi(ai: AiProvider, options: { model?: string } = {}): FakeAi {
  const model = options.model ?? 'fake:scripted';
  const queue: Answer[] = [];
  const structureQueue: Answer[] = [];
  const fake: FakeAi = {
    calls: [],
    embeddings: [],
    structureCalls: [],
    answerNext: (...answers) => { queue.push(...answers); },
    answerStructureNext: (...answers) => { structureQueue.push(...answers); },
    uninstall: () => ai.setOverrides({}),
  };
  ai.setOverrides({
    embed: async (text) => {
      fake.embeddings.push(text);
      return fakeEmbedding(text);
    },
    evaluate: async (system, user, schema) => {
      const shape = (schema as any).shape ?? {};
      const isStructure = 'connection' in shape && 'headline' in shape;
      const call: FakeCall = { system, user, kind: 'summary' in shape ? 'summary' : 'verdict' in shape ? 'triage' : 'other' };
      (isStructure ? fake.structureCalls : fake.calls).push(call);
      const pending = isStructure ? structureQueue : queue;
      const scripted = pending.length > 0 ? pending.shift() : undefined;
      const answer = scripted === undefined
        ? (isStructure ? new Error('fakeAi: no scripted structure answer') : defaultAnswer(call))
        : typeof scripted === 'function' ? (scripted as (c: FakeCall) => unknown)(call) : scripted;
      if (answer instanceof Error) throw answer;
      const [provider, ...rest] = model.split(':');
      return {
        data: schema.parse(answer),
        model,
        latencyMs: 1,
        attempts: [{ provider, model: rest.join(':'), ok: true, latencyMs: 1 }],
      };
    },
  });
  return fake;
}
