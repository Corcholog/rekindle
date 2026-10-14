CREATE TYPE "public"."action_type" AS ENUM('counter_argument', 'unblocker', 'evidence_citation', 'narrative_bridge', 'other');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('pending', 'extracting', 'summarizing', 'embedding', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'accepted', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."telemetry_component" AS ENUM('summary', 'thesis', 'triage', 'action');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('irrelevant', 'tentative', 'actionable');--> statement-breakpoint
CREATE TABLE "action_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"action_type" "action_type" NOT NULL,
	"custom_type_label" text,
	"target_file" text NOT NULL,
	"target_section" text,
	"observation" text NOT NULL,
	"suggested_action" text NOT NULL,
	"source_reference" text,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"user_feedback" text,
	"written_to_vault" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uri" text NOT NULL,
	"title" text,
	"channel_or_domain" text,
	"source_type" text,
	"raw_text" text,
	"summary" text,
	"embedding" vector(1024),
	"embedding_model" text,
	"consumed_at" timestamp DEFAULT now() NOT NULL,
	"consumption_seq" integer DEFAULT 1 NOT NULL,
	"ingest_status" "ingest_status" DEFAULT 'pending' NOT NULL,
	"ingest_status_reason" text,
	"is_raw_purged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contents_uri_unique" UNIQUE("uri")
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"project_snapshot_id" uuid NOT NULL,
	"verdict" "verdict",
	"confidence_score" real,
	"triage_reasoning" text,
	"evaluated_at" timestamp DEFAULT now() NOT NULL,
	"consumption_seq" integer NOT NULL,
	CONSTRAINT "evaluations_idempotency_idx" UNIQUE("content_id","project_snapshot_id","consumption_seq")
);
--> statement-breakpoint
CREATE TABLE "llm_telemetry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component" "telemetry_component" NOT NULL,
	"suggestion_id" uuid,
	"content_id" uuid,
	"snapshot_id" uuid,
	"model_name" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"cost_usd" real,
	"is_success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"tree_hash" varchar(64) NOT NULL,
	"thesis_text" text,
	"note_titles" jsonb,
	"embedding" vector(1024),
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"folder_path" text NOT NULL,
	"title" text NOT NULL,
	"current_hash" varchar(64),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "projects_folder_path_unique" UNIQUE("folder_path")
);
--> statement-breakpoint
ALTER TABLE "action_suggestions" ADD CONSTRAINT "action_suggestions_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_suggestions" ADD CONSTRAINT "action_suggestions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_suggestions" ADD CONSTRAINT "action_suggestions_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_project_snapshot_id_project_snapshots_id_fk" FOREIGN KEY ("project_snapshot_id") REFERENCES "public"."project_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD CONSTRAINT "llm_telemetry_suggestion_id_action_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."action_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD CONSTRAINT "llm_telemetry_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_telemetry" ADD CONSTRAINT "llm_telemetry_snapshot_id_project_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."project_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_snapshots" ADD CONSTRAINT "project_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_suggestions_status_partial_idx" ON "action_suggestions" USING btree ("status") WHERE "action_suggestions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "contents_consumed_at_idx" ON "contents" USING btree ("consumed_at");--> statement-breakpoint
CREATE INDEX "contents_embedding_idx" ON "contents" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "project_snapshots_embedding_idx" ON "project_snapshots" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "project_snapshots_proj_captured_idx" ON "project_snapshots" USING btree ("project_id","captured_at");