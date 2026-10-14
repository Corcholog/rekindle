CREATE TABLE "project_note_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_snapshot_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"note_path" text NOT NULL,
	"note_title" text NOT NULL,
	"content_snippet" text,
	"embedding" vector(1024),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_note_snapshots" ADD CONSTRAINT "project_note_snapshots_project_snapshot_id_project_snapshots_id_fk" FOREIGN KEY ("project_snapshot_id") REFERENCES "public"."project_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_note_snapshots" ADD CONSTRAINT "project_note_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_note_snapshots_embedding_idx" ON "project_note_snapshots" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "project_note_snapshots_snap_idx" ON "project_note_snapshots" USING btree ("project_snapshot_id");--> statement-breakpoint
CREATE INDEX "project_note_snapshots_proj_idx" ON "project_note_snapshots" USING btree ("project_id");