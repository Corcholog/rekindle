ALTER TABLE "action_suggestions" ADD COLUMN "target_is_new" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "matched_note_path" text;