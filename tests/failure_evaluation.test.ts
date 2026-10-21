import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { fakeEmbedding } from './helpers/fakeAi';
import { ProviderError, type ChatProvider } from '../src/ai/types';

// Audit failure scenarios 1 and 2 (F-09), through the real queue worker and provider chain with
// scripted providers:
// 1. the LLM returns invalid structured output or times out;
// 2. every provider fails.
// A failed project evaluation fails the job, pg-boss retries it, and every attempt is recorded.

type Script = (attempt: number) => ChatProvider[];

const triageAnswer = {
  verdict: 'actionable', confidenceScore: 0.9, triageReasoning: 'Aporta evidencia directa.',
  action: { actionType: 'evidence_citation', observation: 'Dato útil.', suggestedAction: 'Citarlo en el borrador.', targetFile: null },
};

function provider(name: string, model: string, behavior: () => unknown): ChatProvider {
  return { name, model, complete: async () => behavior() } as unknown as ChatProvider;
}
const malformed = (name: string) => provider(name, `${name}-model`, () => { throw new ProviderError('invalid_json', 'not json'); });
const timeout = (name: string) => provider(name, `${name}-model`, () => { throw new ProviderError('timeout', 'timed out'); });
const down = (name: string) => provider(name, `${name}-model`, () => { throw new ProviderError('http', 'connection refused'); });
const answers = (name: string) => provider(name, `${name}-model`, () => ({ data: triageAnswer, usage: { promptTokens: 100, completionTokens: 20 } }));

describe('Failure scenarios: invalid output, timeouts and failing providers', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let boss: any;
  let drizzle: any;
  const scripts = new Map<string, { script: Script; attempts: number }>();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
    drizzle = await import('drizzle-orm');

    // Each content's summary names its script; the real chain runs over the scripted providers
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    const { runChain } = await import('../src/ai/chain');
    sharedAiProvider.setOverrides({
      embed: async (text) => fakeEmbedding(text),
      evaluate: async (system, user, zodSchema, options) => {
        const [, entry] = [...scripts].find(([k]) => user.includes(k))!;
        entry.attempts++;
        return runChain(entry.script(entry.attempts), system, user, zodSchema, options);
      },
    });

    const queue = await import('../src/queue/index');
    boss = queue.boss;
    await queue.startQueue();
    await (await import('../src/workers/evaluationWorker')).setupEvaluationWorker();
  }, 180000);

  afterAll(async () => {
    if (boss) await boss.stop({ graceful: false });
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  async function seed(topic: string) {
    const vector = fakeEmbedding(topic);
    const [project] = await db.insert(schema.projects).values({ folderPath: `Projects/${topic}`, title: topic }).returning();
    const [snapshot] = await db.insert(schema.projectSnapshots).values({
      projectId: project.id, treeHash: topic, thesisText: `Tesis ${topic}`, notesContent: `Notas ${topic}`,
      embedding: vector, embeddingModel: 'bge-m3',
    }).returning();
    const [content] = await db.insert(schema.contents).values({
      uri: `https://example.com/${encodeURIComponent(topic)}`, summary: `Resumen ${topic}`, ingestStatus: 'ready',
      embedding: vector, embeddingModel: 'bge-m3',
    }).returning();
    return { project, snapshot, content };
  }

  async function settle(jobId: string, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await boss.getJobById('evaluate_content', jobId);
      if (job && (job.state === 'completed' || job.state === 'failed')) return job;
      if (Date.now() > deadline) throw new Error(`Job ${jobId} did not settle (state ${job?.state})`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  async function eventsFor(traceId: string, stage: string) {
    const { and, eq, asc } = drizzle;
    return db.select().from(schema.pipelineEvents)
      .where(and(eq(schema.pipelineEvents.traceId, traceId), eq(schema.pipelineEvents.stage, stage)))
      .orderBy(asc(schema.pipelineEvents.createdAt));
  }

  it('scenario 1: malformed output and a timeout fail the job; the retry evaluates once', async () => {
    const { content, snapshot } = await seed('alfarería cerámica esmaltes hornos');
    // First run: DeepSeek returns invalid JSON twice (one malformed retry), Ollama times out.
    // Second run: DeepSeek answers.
    scripts.set('alfarería', { attempts: 0, script: (n) => (n === 1 ? [malformed('deepseek'), timeout('ollama')] : [answers('deepseek')]) });
    const traceId = crypto.randomUUID();
    const jobId = await boss.send('evaluate_content', { contentId: content.id, traceId }, { retryLimit: 2, retryDelay: 1 });

    const job = await settle(jobId);
    expect(job.state).toBe('completed');
    expect(job.retryCount).toBe(1);

    const { eq } = drizzle;
    const evaluations = await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, content.id));
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]).toMatchObject({ verdict: 'actionable', projectSnapshotId: snapshot.id, traceId });
    expect(await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, content.id))).toHaveLength(1);

    const jobs = await eventsFor(traceId, 'evaluate_job');
    expect(jobs.map((e: any) => [e.attempt, e.ok, e.attrs.failures, e.attrs.evaluated])).toEqual([[1, false, 1, 0], [2, true, 0, 1]]);
    const evaluate = await eventsFor(traceId, 'evaluate');
    expect(evaluate.map((e: any) => [e.ok, e.errorKind])).toEqual([[false, 'llm_chain'], [true, null]]);

    const attempts = await db.select().from(schema.llmTelemetry).where(eq(schema.llmTelemetry.traceId, traceId));
    // The triage attempts; the second call that lays out the text is not part of these scenarios
    const kinds = attempts.filter((a: any) => a.component === 'triage').map((a: any) => `${a.provider}:${a.isSuccess ? 'ok' : a.errorKind}`).sort();
    expect(kinds).toEqual(['deepseek:invalid_json', 'deepseek:invalid_json', 'deepseek:ok', 'ollama:timeout'].sort());
  }, 90000);

  it('scenario 2: when every provider fails, the job fails after its retries and the content stays in the backlog', async () => {
    const { project, content } = await seed('ornitología migraciones aves rapaces');
    scripts.set('ornitología', { attempts: 0, script: () => [down('deepseek'), down('gemini'), down('ollama')] });
    const traceId = crypto.randomUUID();
    const jobId = await boss.send('evaluate_content', { contentId: content.id, traceId }, { retryLimit: 1, retryDelay: 1 });

    const job = await settle(jobId);
    expect(job.state).toBe('failed');
    expect(scripts.get('ornitología')!.attempts).toBe(2);

    const { eq } = drizzle;
    expect(await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, content.id))).toHaveLength(0);
    const jobs = await eventsFor(traceId, 'evaluate_job');
    expect(jobs.map((e: any) => [e.attempt, e.ok, e.attrs.failures])).toEqual([[1, false, 1], [2, false, 1]]);

    const attempts = await db.select().from(schema.llmTelemetry).where(eq(schema.llmTelemetry.traceId, traceId));
    expect(attempts).toHaveLength(6); // 3 providers x 2 job runs
    expect(attempts.every((a: any) => !a.isSuccess && a.errorKind === 'http')).toBe(true);
    expect(attempts.filter((a: any) => a.isFallback)).toHaveLength(4);

    // Nothing was stored for the pair, so a later project change re-queues it through the backlog
    const { findBacklogUnevaluatedContents } = await import('../src/evaluator');
    expect(await findBacklogUnevaluatedContents(project.id)).toContain(content.id);

    // The report counts the failure
    const { buildReport } = await import('../src/observability/report');
    const report = await buildReport({ since: new Date(0) });
    expect(report.totals.jobErrors).toEqual(expect.arrayContaining([{ stage: 'evaluate_job', errorKind: 'project_failures', count: 3 }]));
  }, 90000);
});
