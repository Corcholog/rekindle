-- Phase 2 (audit F-07): at most one suggestion per evaluation.
-- Data loss: if a race already created several suggestions for the same
-- evaluation, only the oldest is kept. Their callouts, if any, stay in the vault.
DELETE FROM "action_suggestions" a USING "action_suggestions" b
WHERE a."evaluation_id" = b."evaluation_id"
  AND (a."created_at", a."id") > (b."created_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_suggestions_evaluation_id_unique" ON "action_suggestions" USING btree ("evaluation_id");