import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { z } from 'zod';
import { ChainError, runChain } from '../../src/ai/chain';
import { Attempt } from '../../src/ai/types';
import { ConfigSchema, EvalConfig, EvalResult, ResultSchema, RunDetails } from '../schema';
import { JsonCache, RecordedCall, roundVector, sha256 } from './cache';
import { buildChainFromSpecs } from './chainSpec';
import { effectiveVerdict, loadDataset, validateLabels } from './dataset';
import { estimateCostUsd, percentile } from './metrics';
import { predictionsFromDetails, scoreRun } from './scoring';

export type RunMode = 'live' | 'record' | 'replay';

export interface RunOptions {
  datasetDir: string;
  configPath: string;
  mode: RunMode;
  /** Abort before the estimated spend exceeds this many USD. */
  maxUsd: number;
  /** Require every verdict to be filled in. */
  strict?: boolean;
  resultsDir?: string;
  /** Where the per-config detail file goes (default: <dataset>/runs, inside the git-ignored dataset). */
  detailsDir?: string;
  log?: (message: string) => void;
}

interface SinkEntry {
  phase: 'triage' | 'summary';
  ok: boolean;
  attempts: Attempt[];
  latencyMs: number;
  generated: boolean;
}

class BudgetExceededError extends Error {}

const MALFORMED = new Set(['empty', 'invalid_json', 'schema']);
const gitOutput = (...args: string[]) => execFileSync('git', args, { encoding: 'utf-8' }).trim();

export async function loadConfig(configPath: string): Promise<{ config: EvalConfig; hash: string }> {
  const config = ConfigSchema.parse(JSON.parse(await fs.readFile(configPath, 'utf-8')));
  return { config, hash: sha256(JSON.stringify(config)) };
}

export async function runEval(options: RunOptions): Promise<{ result: EvalResult; resultFile: string }> {
  const log = options.log ?? (() => {});
  const { config, hash: configHash } = await loadConfig(options.configPath);
  const dataset = await loadDataset(options.datasetDir);

  const problems = validateLabels(dataset, { strict: options.strict ?? false });
  if (problems.length > 0) throw new Error(`Etiquetas inválidas:\n- ${problems.join('\n- ')}`);
  const labels = dataset.labels!;
  const cases = labels.cases.filter(c => dataset.projects.some(p => effectiveVerdict(c, p.folderPath) !== null));
  if (cases.length === 0) throw new Error('No hay ningún caso etiquetado: rellena labels.yaml');

  const embeddingCache = await new JsonCache<number[]>(path.join(dataset.dir, 'cache', 'embeddings.json')).load();
  const summaryCache = await new JsonCache<string>(path.join(dataset.dir, 'cache', 'summaries.json')).load();
  const llmCache = await new JsonCache<RecordedCall>(path.join(dataset.dir, 'cache', 'llm.json')).load();

  log('Iniciando PostgreSQL de usar y tirar (Testcontainers)…');
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  // The harness must never see the development database or the real vault
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.VAULT_PATH = dataset.vaultPath;

  try {
    const { env } = await import('../../src/config');
    if (env.DATABASE_URL !== container.getConnectionUri()) throw new Error('La configuración no apunta a la base de datos temporal; se aborta');

    const { db, pool } = await import('../../src/db');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });

    const schema = await import('../../src/db/schema');
    const { inArray } = await import('drizzle-orm');
    const { AiProvider, sharedAiProvider } = await import('../../src/ai/aiProvider');
    const { summarizeText } = await import('../../src/ai/summarize');
    const { reconcileProject } = await import('../../src/vault/reconciler');
    const { evaluateContentMatch } = await import('../../src/evaluator');
    const { retrieveCandidates } = await import('../../src/evaluator/retrieval');

    const embedModel = env.EMBED_MODEL;
    const sink: SinkEntry[] = [];
    let spentUsd = 0;
    let budgetExceeded = false;
    let quotaExhausted = false;
    let replayMiss: string | null = null; // the evaluator swallows per-project errors, so misses are checked per case

    // --- embeddings: cached by model + text, always local (I3)
    const localEmbedder = new AiProvider();
    const embed = async (text: string) => {
      const key = sha256(`${embedModel}\n${text}`);
      const cached = embeddingCache.get(key);
      if (cached) return cached;
      if (options.mode === 'replay') throw new Error('Modo replay: falta un embedding en la caché del dataset');
      const vector = roundVector(await localEmbedder.getEmbedding(text));
      embeddingCache.set(key, vector);
      return vector;
    };
    sharedAiProvider.setOverrides({ embed });

    // --- LLM calls: record / replay around a chain built from the config
    const priceOf = (provider: string, model: string) => config.prices[`${provider}:${model}`];
    const makeEvaluate = (specs: EvalConfig['providers'], phase: SinkEntry['phase']) => {
      const providers = options.mode === 'replay' ? [] : buildChainFromSpecs(specs, process.env);
      return async (system: string, user: string, zodSchema: z.ZodTypeAny, callOptions?: { thinking?: boolean }) => {
        const key = sha256(JSON.stringify({ chain: specs, system, user, options: callOptions ?? null }));
        const recorded = llmCache.get(key);

        // Record mode resumes: answers recorded earlier are reused, failures are retried
        if (options.mode === 'record' && recorded?.ok) return replayRecorded(recorded, phase);

        if (options.mode === 'replay') {
          if (!recorded) {
            replayMiss = `Modo replay: falta una respuesta del LLM en la caché del dataset (clave ${key.slice(0, 12)})`;
            throw new Error(replayMiss);
          }
          return replayRecorded(recorded, phase);
        }

        // Budget guard: estimate the call from its size before spending anything
        const first = providers[0];
        const price = first ? priceOf(first.name, first.model) : undefined;
        if (price) {
          const estimate = estimateCostUsd({ promptTokens: Math.ceil((system.length + user.length) / 3), completionTokens: 800 }, price);
          if (spentUsd + estimate > options.maxUsd) {
            budgetExceeded = true;
            throw new BudgetExceededError(`El gasto estimado superaría EVAL_MAX_USD (${options.maxUsd} USD)`);
          }
        }

        try {
          const result = await runChain(providers, system, user, zodSchema, callOptions, {
            onRateLimit: 'wait',
            ...config.rateLimit,
            sleep: ms => {
              log(`    límite de peticiones: esperando ${Math.round(ms / 1000)} s antes de reintentar…`);
              return new Promise(resolve => setTimeout(resolve, ms));
            },
          });
          for (const attempt of result.attempts) {
            const p = priceOf(attempt.provider, attempt.model);
            if (p) spentUsd += estimateCostUsd(attempt.usage, p);
          }
          sink.push({ phase, ok: true, attempts: result.attempts, latencyMs: result.latencyMs, generated: true });
          if (options.mode === 'record') {
            llmCache.set(key, { ok: true, data: result.data, model: result.model, usage: result.usage, latencyMs: result.latencyMs, attempts: result.attempts });
          }
          return result;
        } catch (err) {
          if (err instanceof ChainError) {
            sink.push({ phase, ok: false, attempts: err.attempts, latencyMs: sumLatency(err.attempts), generated: true });
            if (err.quotaExhausted) quotaExhausted = true;
            // Rate-limit failures are not cached, so a resumed run asks again
            if (options.mode === 'record' && !err.rateLimited) llmCache.set(key, { ok: false, attempts: err.attempts });
          }
          throw err;
        }
      };
    };
    const sumLatency = (attempts: Attempt[]) => attempts.reduce((s, a) => s + a.latencyMs, 0);
    const replayRecorded = (recorded: RecordedCall, phase: SinkEntry['phase']) => {
      sink.push({ phase, ok: recorded.ok, attempts: recorded.attempts, latencyMs: recorded.ok ? recorded.latencyMs : sumLatency(recorded.attempts), generated: false });
      if (!recorded.ok) throw new ChainError('Ningún proveedor de IA pudo responder (grabado)', recorded.attempts);
      return { data: recorded.data, model: recorded.model, usage: recorded.usage, latencyMs: recorded.latencyMs, attempts: recorded.attempts };
    };

    sharedAiProvider.setOverrides({ embed, evaluate: makeEvaluate(config.providers, 'triage') });
    const summaryAi = new AiProvider();
    summaryAi.setOverrides({ embed, evaluate: makeEvaluate(config.summaryProviders, 'summary') });

    // --- project snapshots through the real reconciler
    log(`Reconciliando ${dataset.projects.length} proyectos con embeddings ${embedModel}…`);
    for (const project of dataset.projects) {
      await reconcileProject(path.join(dataset.vaultPath, project.folderPath), dataset.vaultPath, true);
    }
    const projectRows = await db.select().from(schema.projects);
    const folderById = new Map(projectRows.map(p => [p.id, p.folderPath]));
    if (projectRows.length !== dataset.projects.length) throw new Error('No se pudieron sincronizar todos los proyectos del dataset (¿falla Ollama?)');

    // --- run every labeled article
    const articleById = new Map(dataset.articles.map(a => [a.id, a]));
    const contentIdByArticle = new Map<string, string>();
    const detailArticles: RunDetails['articles'] = {};
    let done = 0;

    const saveCaches = () => Promise.all([embeddingCache.save(), summaryCache.save(), llmCache.save()]);

    for (const labelCase of cases) {
      const article = articleById.get(labelCase.article)!;
      const summaryKey = sha256(`${article.text}\n${JSON.stringify(config.summaryProviders)}`);
      let summary = summaryCache.get(summaryKey);
      if (summary === undefined) {
        if (options.mode === 'replay') throw new Error('Modo replay: falta un resumen en la caché del dataset');
        summary = await summarizeText(summaryAi, article.text);
        summaryCache.set(summaryKey, summary);
      }
      const embedding = await embed(summary);

      const [content] = await db.insert(schema.contents).values({
        uri: `eval://${article.id}`, title: article.title, summary, rawText: article.text,
        embedding, embeddingModel: embedModel, ingestStatus: 'ready',
      }).returning({ id: schema.contents.id });
      contentIdByArticle.set(article.id, content.id);

      const ranked = await retrieveCandidates(embedding, { limit: 20, threshold: config.threshold });
      detailArticles[article.id] = {
        summary,
        retrieval: ranked.map(c => ({ project: folderById.get(c.projectId)!, distance: c.distance, level: c.level, note: c.notePath })),
        pairs: {},
      };

      await evaluateContentMatch(content.id, undefined, { threshold: config.threshold });
      await saveCaches(); // progress survives an interrupted run
      if (quotaExhausted) {
        throw new Error('Cuota agotada en el proveedor de IA (límite diario). El progreso quedó guardado: vuelve a ejecutar con --record más tarde para continuar.');
      }
      if (replayMiss) throw new Error(replayMiss);
      if (budgetExceeded) throw new BudgetExceededError(`Se alcanzó EVAL_MAX_USD (${options.maxUsd} USD); resultados parciales descartados`);
      log(`  [${++done}/${cases.length}] ${article.id}`);
    }

    // --- collect predictions
    const evaluationRows = await db.select({
      contentId: schema.evaluations.contentId, verdict: schema.evaluations.verdict, snapshotId: schema.evaluations.projectSnapshotId,
      confidence: schema.evaluations.confidenceScore, reasoning: schema.evaluations.triageReasoning,
    }).from(schema.evaluations).where(inArray(schema.evaluations.contentId, [...contentIdByArticle.values()]));
    const snapshotRows = await db.select({ id: schema.projectSnapshots.id, projectId: schema.projectSnapshots.projectId }).from(schema.projectSnapshots);
    const projectBySnapshot = new Map(snapshotRows.map(s => [s.id, s.projectId]));
    const suggestionRows = await db.select({
      contentId: schema.actionSuggestions.contentId, projectId: schema.actionSuggestions.projectId, targetFile: schema.actionSuggestions.targetFile,
      actionType: schema.actionSuggestions.actionType, observation: schema.actionSuggestions.observation,
      suggestedAction: schema.actionSuggestions.suggestedAction,
    }).from(schema.actionSuggestions).where(inArray(schema.actionSuggestions.contentId, [...contentIdByArticle.values()]));

    const articleByContent = new Map([...contentIdByArticle].map(([articleId, contentId]) => [contentId, articleId]));
    for (const row of evaluationRows) {
      if (!row.verdict) continue;
      const articleId = articleByContent.get(row.contentId)!;
      const projectId = projectBySnapshot.get(row.snapshotId)!;
      const folder = folderById.get(projectId)!;
      const suggestion = suggestionRows.find(x => x.contentId === row.contentId && x.projectId === projectId);
      detailArticles[articleId].pairs[folder] = {
        verdict: row.verdict,
        confidence: row.confidence,
        reasoning: row.reasoning,
        action: suggestion
          ? { type: suggestion.actionType, observation: suggestion.observation, suggestedAction: suggestion.suggestedAction, targetFile: suggestion.targetFile }
          : null,
      };
    }

    const details: RunDetails = {
      config: config.name, configHash, generatedAt: new Date().toISOString(), k: config.k, threshold: config.threshold,
      articles: detailArticles,
    };
    const score = scoreRun({ projects: dataset.projects.map(p => p.folderPath), cases, predictions: predictionsFromDetails(details), k: config.k });
    const triageEntries = sink.filter(e => e.phase === 'triage');
    const allAttempts = sink.flatMap(e => e.attempts);
    const firstProvider = config.providers[0].name;
    const unpriced = new Set<string>();
    let estimatedUsd = 0;
    for (const attempt of allAttempts) {
      if (!attempt.usage) continue;
      const price = priceOf(attempt.provider, attempt.model);
      if (price) estimatedUsd += estimateCostUsd(attempt.usage, price);
      else unpriced.add(`${attempt.provider}:${attempt.model}`);
    }
    const generatedCalls = sink.filter(e => e.generated).length;

    const result: EvalResult = ResultSchema.parse({
      meta: {
        gitSha: gitOutput('rev-parse', '--short', 'HEAD'),
        gitDirty: gitOutput('status', '--porcelain') !== '',
        config: config.name,
        configHash,
        dataset: path.basename(dataset.dir),
        datasetManifestHash: dataset.manifestHash,
        labeledBy: labels.labeled_by,
        mode: options.mode,
        embeddingModel: embedModel,
        cases: score.cases,
        labeledPairs: score.labeledPairs,
        startedAt: new Date().toISOString(),
      },
      retrieval: { ...score.retrieval, threshold: config.threshold },
      triage: score.triage,
      reliability: {
        llmCalls: triageEntries.length,
        attempts: triageEntries.reduce((s, e) => s + e.attempts.length, 0),
        malformedOutputs: triageEntries.flatMap(e => e.attempts).filter(a => !a.ok && a.errorKind && MALFORMED.has(a.errorKind)).length,
        fallbacks: triageEntries.filter(e => e.ok && e.attempts.at(-1)!.provider !== firstProvider).length,
        failures: triageEntries.filter(e => !e.ok).length,
        rateLimitHits: triageEntries.flatMap(e => e.attempts).filter(a => a.errorKind === 'rate_limit').length,
        unavailableHits: triageEntries.flatMap(e => e.attempts).filter(a => a.errorKind === 'unavailable').length,
        rateLimitWaitMs: triageEntries.flatMap(e => e.attempts).reduce((s, a) => s + (a.waitedMs ?? 0), 0),
        latencyMsP50: percentile(triageEntries.filter(e => e.ok).map(e => e.latencyMs), 50),
        latencyMsP95: percentile(triageEntries.filter(e => e.ok).map(e => e.latencyMs), 95),
      },
      cost: {
        promptTokens: allAttempts.reduce((s, a) => s + (a.usage?.promptTokens ?? 0), 0),
        completionTokens: allAttempts.reduce((s, a) => s + (a.usage?.completionTokens ?? 0), 0),
        estimatedUsd: unpriced.size === allAttempts.filter(a => a.usage).length && unpriced.size > 0 ? null : estimatedUsd,
        note: unpriced.size > 0
          ? `No price configured for ${[...unpriced].join(', ')}; their cost is not included. ${generatedCalls} of ${sink.length} LLM calls were made in this run (the rest replayed from cache).`
          : `${generatedCalls} of ${sink.length} LLM calls were made in this run (the rest replayed from cache). Local models are counted as $0.`,
      },
    });

    const resultsDir = options.resultsDir ?? path.resolve('evals/results');
    await fs.mkdir(resultsDir, { recursive: true });
    const stamp = result.meta.startedAt.replace(/[:.]/g, '-');
    const resultFile = path.join(resultsDir, `${stamp}-${result.meta.gitSha}-${config.name}-${result.meta.dataset}.json`);
    await fs.writeFile(resultFile, JSON.stringify(result, null, 2) + '\n', 'utf-8');

    const detailsDir = options.detailsDir ?? path.join(dataset.dir, 'runs');
    await fs.mkdir(detailsDir, { recursive: true });
    await fs.writeFile(path.join(detailsDir, `${config.name}.json`), JSON.stringify(details, null, 2), 'utf-8');

    await saveCaches();
    await pool.end();
    return { result, resultFile };
  } finally {
    await container.stop();
  }
}

