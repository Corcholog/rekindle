ALTER TABLE "action_suggestions" ADD COLUMN "action_steps" jsonb;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "reasoning_connection" text;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "reasoning_gap" text;