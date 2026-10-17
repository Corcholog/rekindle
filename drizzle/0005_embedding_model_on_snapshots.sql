ALTER TABLE "project_note_snapshots" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "project_snapshots" ADD COLUMN "embedding_model" text;--> statement-breakpoint
-- Backfill (invariant I7): every embedding stored before this migration was computed with
-- bge-m3, the only model Loom has used (confirmed by the owner, 2026-10-17).
UPDATE "project_snapshots" SET "embedding_model" = 'bge-m3' WHERE "embedding" IS NOT NULL AND "embedding_model" IS NULL;--> statement-breakpoint
UPDATE "project_note_snapshots" SET "embedding_model" = 'bge-m3' WHERE "embedding" IS NOT NULL AND "embedding_model" IS NULL;--> statement-breakpoint
UPDATE "contents" SET "embedding_model" = 'bge-m3' WHERE "embedding" IS NOT NULL AND "embedding_model" IS NULL;
