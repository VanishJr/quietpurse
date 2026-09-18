DROP INDEX "transfer_rules_desc_account_unique";--> statement-breakpoint
ALTER TABLE "transfer_rules" ADD COLUMN "match_mode" text DEFAULT 'exact' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_rules_desc_account_unique" ON "transfer_rules" USING btree ("description","account_id","match_mode");--> statement-breakpoint
ALTER TABLE "transfer_rules" ADD CONSTRAINT "transfer_rules_match_mode_check" CHECK ("transfer_rules"."match_mode" IN ('exact', 'similar-v1'));