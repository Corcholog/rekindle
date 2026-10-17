-- Phase 1 cleanup (audit 2026-10-17). Drops columns no code path writes.
-- Data loss: only values written by the removed scripts/seed_demo.ts
-- (custom_type_label, target_section, source_reference); source_type was
-- never written (always NULL) and is_raw_purged was always false.
ALTER TABLE "action_suggestions" DROP COLUMN "custom_type_label";--> statement-breakpoint
ALTER TABLE "action_suggestions" DROP COLUMN "target_section";--> statement-breakpoint
ALTER TABLE "action_suggestions" DROP COLUMN "source_reference";--> statement-breakpoint
ALTER TABLE "contents" DROP COLUMN "source_type";--> statement-breakpoint
ALTER TABLE "contents" DROP COLUMN "is_raw_purged";