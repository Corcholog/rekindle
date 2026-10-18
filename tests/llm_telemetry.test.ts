import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { z } from 'zod';
import { runChain, ChainError } from '../src/ai/chain';
import { ChatProvider, ProviderError } from '../src/ai/types';
import { attemptCostUsd } from '../src/ai/pricing';

// src/observability/llmTelemetry imports src/db, which binds its pool to DATABASE_URL on first
// import: it is only imported after the Testcontainers URL is stubbed.

const SENTINEL = 'SENTINEL-telemetria-nota-privada';
const schema = z.object({ answer: z.string() });

function fakeProvider(name: string, model: string, script: Array<() => unknown>): ChatProvider {
  let call = 0;
  return {
    name, model,
    async complete() {
      const step = script[Math.min(call++, script.length - 1)];
      return step() as any;
    },
  } as ChatProvider;
}

describe('LLM telemetry rows (one per attempt)', () => {
  let telemetryRows: typeof import('../src/observability/llmTelemetry').telemetryRows;
  let promptHash: typeof import('../src/observability/llmTelemetry').promptHash;
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schemaDb: any;
  let AiProvider: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schemaDb = await import('../src/db/schema');
    ({ AiProvider } = await import('../src/ai/aiProvider'));
    ({ telemetryRows, promptHash } = await import('../src/observability/llmTelemetry'));
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it('records rate limits, malformed retries and fallback from a real chain run', async () => {
    const providers = [
      fakeProvider('deepseek', 'deepseek-flash', [() => { throw new ProviderError('rate_limit', `429 ${SENTINEL}`); }]),
      fakeProvider('ollama', 'qwen2.5:7b-instruct', [
        () => { throw new ProviderError('invalid_json', `bad json: ${SENTINEL}`); },
        () => ({ data: { answer: `${SENTINEL} respuesta` }, usage: { promptTokens: 100, completionTokens: 20 } }),
      ]),
    ];
    const system = `Sistema ${SENTINEL}`;
    const user = `Nota del usuario ${SENTINEL}`;
    const result = await runChain(providers, system, user, schema);

    const rows = telemetryRows({ component: 'triage', traceId: 't-1', contentId: null, snapshotId: null }, system, user, result.attempts, result.data);

    expect(rows.map(r => [r.provider, r.attemptNo, r.isSuccess, r.errorKind, r.isFallback])).toEqual([
      ['deepseek', 1, false, 'rate_limit', false],
      ['ollama', 2, false, 'invalid_json', true],
      ['ollama', 3, true, null, true],
    ]);
    expect(rows[2]).toMatchObject({ promptTokens: 100, completionTokens: 20, costUsd: 0, modelName: 'ollama:qwen2.5:7b-instruct' });
    expect(rows[0].costUsd).toBeNull(); // no usage reported for a failed attempt
    expect(rows.every(r => r.promptChars === system.length + user.length)).toBe(true);
    expect(rows[2].completionChars).toBe(JSON.stringify(result.data).length);
    expect(rows[0].completionChars).toBeNull();
    expect(rows[0].promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(rows[0].promptHash).toBe(promptHash(system, user));

    // Only lengths and a hash describe the prompt and the answer
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
  });

  it('prices DeepSeek at list price, Ollama at zero and leaves Gemini unpriced', () => {
    expect(attemptCostUsd('deepseek', 'deepseek-flash', { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(1.5, 10);
    expect(attemptCostUsd('ollama', 'qwen2.5:7b-instruct', { promptTokens: 5000 })).toBe(0);
    expect(attemptCostUsd('gemini', 'gemini-3.1-flash-lite', { promptTokens: 5000 })).toBeNull();
    expect(attemptCostUsd('deepseek', 'deepseek-flash', undefined)).toBeNull();
  });

  // --- AiProvider writes the rows (database)

  async function rowsFor(component: string) {
    const { eq } = await import('drizzle-orm');
    return db.select().from(schemaDb.llmTelemetry).where(eq(schemaDb.llmTelemetry.component, component));
  }

  it('writes one row per attempt and returns their IDs', async () => {
    const ai = new AiProvider();
    ai.setOverrides({
      evaluate: async () => ({
        data: { answer: 'ok' }, model: 'gemini:gemini-3.1-flash-lite', latencyMs: 30,
        attempts: [
          { provider: 'deepseek', model: 'deepseek-flash', ok: false, errorKind: 'unavailable', latencyMs: 10 },
          { provider: 'gemini', model: 'gemini-3.1-flash-lite', ok: true, latencyMs: 30, usage: { promptTokens: 50, completionTokens: 5 } },
        ],
      }),
    });
    const result = await ai.evaluateContent('s', 'u', schema, undefined, { component: 'consult' });

    const rows = await rowsFor('consult');
    expect(rows).toHaveLength(2);
    expect(result.telemetryIds.sort()).toEqual(rows.map((r: any) => r.id).sort());
    expect(rows.find((r: any) => r.isFallback)).toMatchObject({ provider: 'gemini', isSuccess: true, promptTokens: 50 });
  });

  it('records the failed attempts of a call that throws, and rethrows', async () => {
    const ai = new AiProvider();
    ai.setOverrides({
      evaluate: async () => {
        throw new ChainError('Ningún proveedor de IA pudo responder', [
          { provider: 'ollama', model: 'qwen2.5:7b-instruct', ok: false, errorKind: 'http', latencyMs: 5 },
        ]);
      },
    });
    await expect(ai.evaluateContent('s', 'u', schema, undefined, { component: 'synergy' })).rejects.toBeInstanceOf(ChainError);

    const rows = await rowsFor('synergy');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isSuccess: false, errorKind: 'http', provider: 'ollama' });
  });

  it('writes nothing without a call context', async () => {
    const ai = new AiProvider();
    ai.setOverrides({ evaluate: async () => ({ data: { answer: 'ok' }, model: 'ollama:qwen' }) });
    const before = (await db.select().from(schemaDb.llmTelemetry)).length;
    const result = await ai.evaluateContent('s', 'u', schema);
    expect(result.telemetryIds).toBeUndefined();
    expect((await db.select().from(schemaDb.llmTelemetry)).length).toBe(before);
  });
});
