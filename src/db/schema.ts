import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  timestamp,
  jsonb,
  integer,
  real,
  index,
  pgEnum,
  unique,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';

// Custom type para el vector de pgvector
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(1024)'; // Actualizado a 1024 para bge-m3
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    // pgvector devuelve strings en la forma "[1,2,3]"
    return value.replace(/\[|\]/g, '').split(',').map(Number);
  },
});

// Enums
export const ingestStatusEnum = pgEnum('ingest_status', ['pending', 'extracting', 'summarizing', 'embedding', 'ready', 'failed']);
export const verdictEnum = pgEnum('verdict', ['irrelevant', 'tentative', 'actionable']);
export const actionTypeEnum = pgEnum('action_type', ['counter_argument', 'unblocker', 'evidence_citation', 'narrative_bridge', 'other']);
export const suggestionStatusEnum = pgEnum('suggestion_status', ['pending', 'accepted', 'discarded']);
// Why the owner discarded a suggestion (optional), from a fixed list
export const DISCARD_REASONS = ['unrelated', 'obvious', 'wrong_note', 'poorly_worded', 'other'] as const;
export const discardReasonEnum = pgEnum('discard_reason', DISCARD_REASONS);
export const telemetryComponentEnum = pgEnum('telemetry_component', ['summary', 'thesis', 'triage', 'action', 'consult', 'synergy', 'synthesis', 'reevaluate']);
export const pipelineStageEnum = pgEnum('pipeline_stage', ['fetch', 'extract', 'summarize', 'embed', 'retrieve', 'evaluate', 'ingest_job', 'evaluate_job']);

// 1. Contents Table
export const contents = pgTable('contents', {
  id: uuid('id').defaultRandom().primaryKey(),
  uri: text('uri').notNull().unique(), // Canonicalizada
  title: text('title'),
  channelOrDomain: text('channel_or_domain'),
  rawText: text('raw_text'),
  summary: text('summary'),
  embedding: vector('embedding'),
  embeddingModel: text('embedding_model'),
  consumedAt: timestamp('consumed_at').defaultNow().notNull(),
  consumptionSeq: integer('consumption_seq').default(1).notNull(),
  ingestStatus: ingestStatusEnum('ingest_status').default('pending').notNull(),
  ingestStatusReason: text('ingest_status_reason'),
  // Correlation ID of the ingestion that produced this row (Phase 4)
  traceId: uuid('trace_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('contents_consumed_at_idx').on(table.consumedAt),
  index('contents_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops'))
]);

// 2. Projects Table
export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  folderPath: text('folder_path').notNull().unique(),
  title: text('title').notNull(),
  currentHash: varchar('current_hash', { length: 64 }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 3. Project Snapshots Table
export const projectSnapshots = pgTable('project_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  treeHash: varchar('tree_hash', { length: 64 }).notNull(),
  thesisText: text('thesis_text'),
  notesContent: text('notes_content'),
  noteTitles: jsonb('note_titles').$type<string[]>(),
  embedding: vector('embedding'),
  embeddingModel: text('embedding_model'),
  capturedAt: timestamp('captured_at').defaultNow().notNull(),
  // Newest modification time of the project's own notes (Rekindle's files excluded). With a time
  // zone, so it compares correctly with Node's clock; null on snapshots taken before it existed.
  notesModifiedAt: timestamp('notes_modified_at', { withTimezone: true }),
}, (table) => [
  index('project_snapshots_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  index('project_snapshots_proj_captured_idx').on(table.projectId, table.capturedAt)
]);

// 3.1 Project Note Snapshots Table (Hierarchical / Note-Level Embeddings)
export const projectNoteSnapshots = pgTable('project_note_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectSnapshotId: uuid('project_snapshot_id').references(() => projectSnapshots.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  notePath: text('note_path').notNull(),
  noteTitle: text('note_title').notNull(),
  contentSnippet: text('content_snippet'),
  embedding: vector('embedding'),
  embeddingModel: text('embedding_model'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('project_note_snapshots_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  index('project_note_snapshots_snap_idx').on(table.projectSnapshotId),
  index('project_note_snapshots_proj_idx').on(table.projectId)
]);

// 4. Evaluations Table
export const evaluations = pgTable('evaluations', {
  id: uuid('id').defaultRandom().primaryKey(),
  contentId: uuid('content_id').references(() => contents.id, { onDelete: 'cascade' }).notNull(),
  projectSnapshotId: uuid('project_snapshot_id').references(() => projectSnapshots.id, { onDelete: 'cascade' }).notNull(),
  verdict: verdictEnum('verdict'),
  confidenceScore: real('confidence_score'),
  triageReasoning: text('triage_reasoning'),
  evaluatedAt: timestamp('evaluated_at').defaultNow().notNull(),
  consumptionSeq: integer('consumption_seq').notNull(),
  traceId: uuid('trace_id'),
  // The retrieval step that selected this project for the content
  retrievalEventId: uuid('retrieval_event_id').references(() => pipelineEvents.id, { onDelete: 'set null' }),
  // Whole days the project's notes had been untouched when this evaluation ran (null: unknown).
  // Kept on the evaluation, so "rekindles a project idle for N days" stays true after later edits.
  projectIdleDays: integer('project_idle_days'),
}, (table) => [
  unique('evaluations_idempotency_idx').on(table.contentId, table.projectSnapshotId, table.consumptionSeq)
]);

// 5. Action Suggestions Table
export const actionSuggestions = pgTable('action_suggestions', {
  id: uuid('id').defaultRandom().primaryKey(),
  evaluationId: uuid('evaluation_id').references(() => evaluations.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  contentId: uuid('content_id').references(() => contents.id, { onDelete: 'cascade' }).notNull(),
  actionType: actionTypeEnum('action_type').notNull(),
  targetFile: text('target_file').notNull(),
  observation: text('observation').notNull(),
  suggestedAction: text('suggested_action').notNull(),
  status: suggestionStatusEnum('status').default('pending').notNull(),
  userFeedback: text('user_feedback'),
  discardReason: discardReasonEnum('discard_reason'),
  writtenToVault: boolean('written_to_vault').default(false).notNull(),
  resolvedAt: timestamp('resolved_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  // Partial index on status. In Drizzle we use SQL template for partial conditions.
  index('action_suggestions_status_partial_idx')
    .on(table.status)
    .where(sql`${table.status} = 'pending'`),
  // One suggestion per evaluation: a double accept of a tentative item cannot create two
  uniqueIndex('action_suggestions_evaluation_id_unique').on(table.evaluationId)
]);

// 6. LLM Telemetry Table
export const llmTelemetry = pgTable('llm_telemetry', {
  id: uuid('id').defaultRandom().primaryKey(),
  component: telemetryComponentEnum('component').notNull(),
  suggestionId: uuid('suggestion_id').references(() => actionSuggestions.id, { onDelete: 'set null' }),
  contentId: uuid('content_id').references(() => contents.id, { onDelete: 'set null' }),
  snapshotId: uuid('snapshot_id').references(() => projectSnapshots.id, { onDelete: 'set null' }),
  modelName: text('model_name').notNull(),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  latencyMs: integer('latency_ms'),
  costUsd: real('cost_usd'),
  isSuccess: boolean('is_success').default(true).notNull(),
  errorMessage: text('error_message'),
  // One row per provider attempt. Only lengths and a hash of the prompt are kept, never its text.
  traceId: uuid('trace_id'),
  provider: text('provider'),
  attemptNo: integer('attempt_no'),
  errorKind: text('error_kind'),
  isFallback: boolean('is_fallback').default(false).notNull(),
  waitedMs: integer('waited_ms'),
  promptChars: integer('prompt_chars'),
  completionChars: integer('completion_chars'),
  promptHash: varchar('prompt_hash', { length: 16 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('llm_telemetry_created_at_idx').on(table.createdAt),
  index('llm_telemetry_trace_id_idx').on(table.traceId)
]);

// 7. Pipeline Events Table: one row per pipeline stage of a trace (Phase 4).
// attrs holds IDs, counts, lengths and distances only, never note or article text.
export const pipelineEvents = pgTable('pipeline_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  traceId: uuid('trace_id').notNull(),
  stage: pipelineStageEnum('stage').notNull(),
  contentId: uuid('content_id').references(() => contents.id, { onDelete: 'set null' }),
  snapshotId: uuid('snapshot_id').references(() => projectSnapshots.id, { onDelete: 'set null' }),
  durationMs: integer('duration_ms'),
  ok: boolean('ok').default(true).notNull(),
  errorKind: text('error_kind'),
  attempt: integer('attempt'),
  attrs: jsonb('attrs').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('pipeline_events_trace_id_idx').on(table.traceId),
  index('pipeline_events_created_at_idx').on(table.createdAt)
]);
