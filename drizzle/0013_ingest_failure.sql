ALTER TABLE "contents" ADD COLUMN "ingest_failure_kind" text;--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "pasted_text" boolean DEFAULT false NOT NULL;