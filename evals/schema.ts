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

const LanguageSchema = z.enum(['es', 'en']);

export const LanguagesSchema = z.object({
  /** Instructions of the triage prompt (the summary prompt keeps Spanish instructions). */
  prompt: LanguageSchema.optional(),
  /** Language the model writes reasoning and actions in. */
  output: LanguageSchema.optional(),
  /** Language of the summaries, which are embedded and compared with the notes. */
  summary: LanguageSchema.optional(),
});
export type EvalLanguages = z.infer<typeof LanguagesSchema>;

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
  /** Closest projects handed to the LLM per article. The default (10) is "no cap" for the 8-project datasets; production uses TOP_K_PROJECTS_LIMIT (3). */
  maxProjects: z.number().int().positive().default(10),
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
  /**
   * Language experiments (src/ai/language.ts). Each field defaults to Spanish, the setup every
   * earlier result was measured with; leaving the block out keeps the config hash unchanged.
   */
  languages: LanguagesSchema.optional(),
});
export type EvalConfig = z.infer<typeof ConfigSchema>;

const NullableNumber = z.number().nullable();

/** What one model said about one (article, project) pair, kept privately for the review page. */
export const PairDetailSchema = z.object({
  verdict: VerdictSchema,
  confidence: z.number().nullable(),
  reasoning: z.string().nullable(),
  action: z.object({
    type: z.string(),
    observation: z.string(),
    suggestedAction: z.string(),
    targetFile: z.string(),
  }).nullable(),
});

/**
 * Per-config detail of a run: summaries, retrieval distances and every model answer. It holds
 * text derived from the owner's notes, so it is written inside the (git-ignored) dataset only.
 */
export const RunDetailsSchema = z.object({
  config: z.string(),
  configHash: z.string(),
  generatedAt: z.string(),
  k: z.number(),
  threshold: z.number(),
  articles: z.record(z.string(), z.object({
    /** Trace of the article's evaluation in the run database (pipeline_events, llm_telemetry). */
    traceId: z.string().optional(),
    summary: z.string(),
    retrieval: z.array(z.object({
      project: z.string(),
      distance: z.number(),
      level: z.enum(['note', 'project']),
      note: z.string().nullable(),
    })),
    pairs: z.record(z.string(), PairDetailSchema),
  })),
});
export type RunDetails = z.infer<typeof RunDetailsSchema>;

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
    /** Present when the config ran a language experiment. */
    languages: z.object({ prompt: LanguageSchema, output: LanguageSchema, summary: LanguageSchema }).optional(),
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
    /** Attempts that found the provider overloaded or down (HTTP 5xx). */
    unavailableHits: z.number(),
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
  /**
   * The production telemetry (llm_telemetry, pipeline_events) of the run's throwaway database,
   * summarized by the same code as `pnpm telemetry:report`. Absent in results from before Phase 4.
   * In replay mode stage latencies measure the pipeline without model time.
   */
  telemetry: z.object({
    llmCalls: z.number(),
    failedCalls: z.number(),
    fallbackCalls: z.number(),
    attempts: z.number(),
    malformedAttempts: z.number(),
    stages: z.array(z.object({
      stage: z.string(), events: z.number(), failures: z.number(), p50Ms: NullableNumber, p95Ms: NullableNumber,
    })),
  }).optional(),
});
export type EvalResult = z.infer<typeof ResultSchema>;
