CREATE TABLE "project_note_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_snapshot_id" uuid NOT NULL,
	"project_snapshot_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"heading" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedding_model" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_note_chunks" ADD CONSTRAINT "project_note_chunks_note_snapshot_id_project_note_snapshots_id_fk" FOREIGN KEY ("note_snapshot_id") REFERENCES "public"."project_note_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_note_chunks" ADD CONSTRAINT "project_note_chunks_project_snapshot_id_project_snapshots_id_fk" FOREIGN KEY ("project_snapshot_id") REFERENCES "public"."project_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_note_chunks" ADD CONSTRAINT "project_note_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_note_chunks_note_idx" ON "project_note_chunks" USING btree ("note_snapshot_id");--> statement-breakpoint
CREATE INDEX "project_note_chunks_snap_idx" ON "project_note_chunks" USING btree ("project_snapshot_id");--> statement-breakpoint
CREATE INDEX "project_note_chunks_hash_idx" ON "project_note_chunks" USING btree ("project_id","content_hash");