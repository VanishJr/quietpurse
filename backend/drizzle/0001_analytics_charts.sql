CREATE TABLE "analytics_charts" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"sort" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"range" text NOT NULL,
	"breakdown" text NOT NULL,
	"account_id" text,
	"metrics" text DEFAULT '[]' NOT NULL,
	CONSTRAINT "analytics_charts_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "analytics_charts_kind" CHECK ("analytics_charts"."kind" IN ('line', 'column', 'area', 'donut', 'ranking', 'radar')),
	CONSTRAINT "analytics_charts_range" CHECK ("analytics_charts"."range" IN ('3m', '6m', '12m', '24m', '3y', '5y')),
	CONSTRAINT "analytics_charts_breakdown" CHECK ("analytics_charts"."breakdown" IN ('expense-categories', 'income-categories', 'income-sources'))
);
--> statement-breakpoint
ALTER TABLE "analytics_charts" ADD CONSTRAINT "analytics_charts_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;