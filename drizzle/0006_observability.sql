CREATE TYPE "public"."pipeline_stage" AS ENUM('fetch', 'extract', 'summarize', 'embed', 'retrieve', 'evaluate', 'ingest_job', 'evaluate_job');--> statement-breakpoint
ALTER TYPE "public"."telemetry_component" ADD VALUE 'consult';--> statement-breakpoint
ALTER TYPE "public"."telemetry_component" ADD VALUE 'synergy';--> statement-breakpoint
ALTER TYPE "public"."telemetry_component" ADD VALUE 'synthesis';--> statement-breakpoint
ALTER TYPE "public"."telemetry_component" ADD VALUE 'reevaluate';--> statement-breakpoint
CREATE TABLE "pipeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"stage" "pipeline_stage" NOT NULL,
	"content_id" uuid,
	"snapshot_id" uuid,
	"duration_ms" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"error_kind" text,
	"attempt" integer,
	"attrs" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "trace_id" uuid;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "trace_id" uuid;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "retrieval_event_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD COLUMN "trace_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD COLUMN "attempt_no" integer;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD COLUMN "is_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD COLUMN "waited_ms" integer;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD COLUMN "prompt_chars" integer;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD COLUMN "completion_chars" integer;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD COLUMN "prompt_hash" varchar(16);--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_snapshot_id_project_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."project_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_events_trace_id_idx" ON "pipeline_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "pipeline_events_created_at_idx" ON "pipeline_events" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_retrieval_event_id_pipeline_events_id_fk" FOREIGN KEY ("retrieval_event_id") REFERENCES "public"."pipeline_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_telemetry_created_at_idx" ON "llm_telemetry" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_telemetry_trace_id_idx" ON "llm_telemetry" USING btree ("trace_id");--> statement-breakpoint
-- Backfill: rows written before this migration stored "provider:model" in model_name
UPDATE "llm_telemetry" SET "provider" = split_part("model_name", ':', 1) WHERE "provider" IS NULL AND position(':' in "model_name") > 0;
