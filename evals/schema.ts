import { z } from 'zod';

export const VerdictSchema = z.enum(['actionable', 'tentative', 'irrelevant']);

export const ArticleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'id: lowercase letters, digits, - and _'),
  title: z.string().min(1),
  url: z.string().url().optional(),
  source: z.enum(['real', 'synthetic']),
  text: z.string().min(1),
});
export type Article = z.infer<typeof ArticleSchema>;

/** The owner's judgement for one article against one project. */
export const ProjectLabelSchema = z.object({
  verdict: VerdictSchema.nullable(),
  target_note: z.string().nullable().optional(),
});

export const LabelCaseSchema = z.object({
  article: z.string(),
  /**
   * Shortcut written by the labeler: the verdict for every project left blank below (usually
   * "irrelevant"), so only the projects that matter need an explicit answer.
   */
  others: VerdictSchema.nullable().optional(),
  projects: z.record(z.string(), ProjectLabelSchema),
  notes: z.string().nullable().optional(),
});

export const LabelsSchema = z.object({
  labeled_by: z.string().nullable(),
  cases: z.array(LabelCaseSchema),
});
export type Labels = z.infer<typeof LabelsSchema>;

const ProviderSpecSchema = z.object({
  name: z.enum(['deepseek', 'gemini', 'ollama']),
  model: z.string().optional(),
  /** DeepSeek thinking mode; off unless a config opts in. */
  thinking: z.boolean().optional(),
  /** Minimum time between calls to this provider, to stay under its requests-per-minute limit. */
  minIntervalMs: z.number().int().nonnegative().optional(),
});
export type ProviderSpec = z.infer<typeof ProviderSpecSchema>;

export const PriceSchema = z.object({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
});

export const ConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Providers for triage and action suggestions, tried in order. */
  providers: z.array(ProviderSpecSchema).min(1),
  /** Providers for article summaries. Keep identical across configs to compare them on the same summaries. */
  summaryProviders: z.array(ProviderSpecSchema).min(1),
  /** Retrieval cutoff K for precision/recall. */
  k: z.number().int().positive().default(3),
  /** Cosine-distance threshold for retrieval (sweeps override the default 0.6). */
  threshold: z.number().positive().default(0.6),
  /**
   * Evals never fall back on a rate limit: they wait and retry the same provider (honoring the
   * provider's suggested delay), then fail the call. Defaults suit free-tier Gemini.
   */
  rateLimit: z.object({
    maxRetries: z.number().int().nonnegative().default(6),
    baseDelayMs: z.number().int().positive().default(15_000),
    maxDelayMs: z.number().int().positive().default(120_000),
  }).default({ maxRetries: 6, baseDelayMs: 15_000, maxDelayMs: 120_000 }),
  /** USD per million tokens, keyed "provider:model". Missing entries mean cost is not measured. */
  prices: z.record(z.string(), PriceSchema).default({}),
});
export type EvalConfig = z.infer<typeof ConfigSchema>;

const NullableNumber = z.number().nullable();

export const ResultSchema = z.object({
  meta: z.object({
    gitSha: z.string(),
    gitDirty: z.boolean(),
    config: z.string(),
    configHash: z.string(),
    dataset: z.string(),
    datasetManifestHash: z.string(),
    labeledBy: z.string().nullable(),
    mode: z.enum(['live', 'record', 'replay']),
    embeddingModel: z.string(),
    cases: z.number(),
    labeledPairs: z.number(),
    startedAt: z.string(),
  }),
  retrieval: z.object({
    k: z.number(),
    threshold: z.number(),
    precisionAtK: NullableNumber,
    recallAtK: NullableNumber,
    casesWithRelevant: z.number(),
    falseRetrievalRate: NullableNumber,
    casesWithoutRelevant: z.number(),
  }),
  triage: z.object({
    confusion: z.record(z.string(), z.record(z.string(), z.number())),
    perClass: z.record(z.string(), z.object({
      precision: NullableNumber, recall: NullableNumber, f1: NullableNumber, support: z.number(),
    })),
    macroF1: NullableNumber,
    targetNoteAccuracy: NullableNumber,
    targetNoteCases: z.number(),
  }),
  reliability: z.object({
    llmCalls: z.number(),
    attempts: z.number(),
    malformedOutputs: z.number(),
    fallbacks: z.number(),
    failures: z.number(),
    /** Attempts answered with HTTP 429, and the total time spent waiting because of them. */
    rateLimitHits: z.number(),
    rateLimitWaitMs: z.number(),
    latencyMsP50: NullableNumber,
    latencyMsP95: NullableNumber,
  }),
  cost: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    estimatedUsd: NullableNumber,
    note: z.string(),
  }),
});
export type EvalResult = z.infer<typeof ResultSchema>;
