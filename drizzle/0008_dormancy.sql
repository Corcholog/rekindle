ALTER TABLE "evaluations" ADD COLUMN "project_idle_days" integer;--> statement-breakpoint
ALTER TABLE "project_snapshots" ADD COLUMN "notes_modified_at" timestamp with time zone;