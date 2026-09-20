CREATE TABLE "category_spending_goals" (
	"goal_id" text PRIMARY KEY NOT NULL,
	"goal_type" text NOT NULL,
	"category" text NOT NULL,
	"monthly_limit_cents" integer NOT NULL,
	"base_currency" text NOT NULL,
	CONSTRAINT "category_spending_goals_category_unique" UNIQUE("category"),
	CONSTRAINT "category_spending_goals_type_check" CHECK ("category_spending_goals"."goal_type" = 'category-spending-limit'),
	CONSTRAINT "category_spending_goals_limit_check" CHECK ("category_spending_goals"."monthly_limit_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "debt_payoff_goals" (
	"goal_id" text PRIMARY KEY NOT NULL,
	"goal_type" text NOT NULL,
	"account_id" text NOT NULL,
	"starting_debt_cents" integer NOT NULL,
	"target_debt_cents" integer NOT NULL,
	"currency" text NOT NULL,
	CONSTRAINT "debt_payoff_goals_type_check" CHECK ("debt_payoff_goals"."goal_type" = 'debt-payoff'),
	CONSTRAINT "debt_payoff_goals_start_check" CHECK ("debt_payoff_goals"."starting_debt_cents" > 0),
	CONSTRAINT "debt_payoff_goals_target_check" CHECK ("debt_payoff_goals"."target_debt_cents" >= 0 AND "debt_payoff_goals"."target_debt_cents" < "debt_payoff_goals"."starting_debt_cents")
);
--> statement-breakpoint
CREATE TABLE "emergency_fund_goals" (
	"goal_id" text PRIMARY KEY NOT NULL,
	"goal_type" text NOT NULL,
	"monthly_essentials_cents" integer NOT NULL,
	"coverage_months" integer NOT NULL,
	"currency" text NOT NULL,
	CONSTRAINT "emergency_fund_goals_type_check" CHECK ("emergency_fund_goals"."goal_type" = 'emergency-fund'),
	CONSTRAINT "emergency_fund_goals_amount_check" CHECK ("emergency_fund_goals"."monthly_essentials_cents" > 0),
	CONSTRAINT "emergency_fund_goals_coverage_check" CHECK ("emergency_fund_goals"."coverage_months" BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "financial_independence_goals" (
	"goal_id" text PRIMARY KEY NOT NULL,
	"goal_type" text NOT NULL,
	"basis" text NOT NULL,
	"buffer_pct" double precision NOT NULL,
	"window_months" integer NOT NULL,
	"hourly_rate_cents" integer,
	"hours_per_week" double precision,
	CONSTRAINT "financial_independence_goals_type_check" CHECK ("financial_independence_goals"."goal_type" = 'financial-independence'),
	CONSTRAINT "financial_independence_goals_basis_check" CHECK ("financial_independence_goals"."basis" IN ('essential-costs', 'current-spending')),
	CONSTRAINT "financial_independence_goals_buffer_check" CHECK ("financial_independence_goals"."buffer_pct" >= 0 AND "financial_independence_goals"."buffer_pct" <= 100),
	CONSTRAINT "financial_independence_goals_window_check" CHECK ("financial_independence_goals"."window_months" BETWEEN 1 AND 24),
	CONSTRAINT "financial_independence_goals_hourly_rate_check" CHECK ("financial_independence_goals"."hourly_rate_cents" IS NULL OR "financial_independence_goals"."hourly_rate_cents" > 0),
	CONSTRAINT "financial_independence_goals_hours_check" CHECK ("financial_independence_goals"."hours_per_week" IS NULL OR ("financial_independence_goals"."hours_per_week" > 0 AND "financial_independence_goals"."hours_per_week" <= 168))
);
--> statement-breakpoint
CREATE TABLE "goal_accounts" (
	"goal_id" text NOT NULL,
	"account_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "goal_accounts_goal_id_account_id_pk" PRIMARY KEY("goal_id","account_id"),
	CONSTRAINT "goal_accounts_position_unique" UNIQUE("goal_id","position"),
	CONSTRAINT "goal_accounts_position_check" CHECK ("goal_accounts"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"target_date" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "goals_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "goals_type_check" CHECK ("goals"."type" IN ('financial-independence', 'emergency-fund', 'savings-balance', 'debt-payoff', 'monthly-income', 'savings-rate', 'category-spending-limit')),
	CONSTRAINT "goals_name_check" CHECK (LENGTH(BTRIM("goals"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "goals_target_date_check" CHECK ("goals"."target_date" IS NULL OR "goals"."target_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "monthly_income_goals" (
	"goal_id" text PRIMARY KEY NOT NULL,
	"goal_type" text NOT NULL,
	"target_monthly_cents" integer NOT NULL,
	"income_scope" text NOT NULL,
	"window_months" integer NOT NULL,
	"base_currency" text NOT NULL,
	CONSTRAINT "monthly_income_goals_type_check" CHECK ("monthly_income_goals"."goal_type" = 'monthly-income'),
	CONSTRAINT "monthly_income_goals_target_check" CHECK ("monthly_income_goals"."target_monthly_cents" > 0),
	CONSTRAINT "monthly_income_goals_scope_check" CHECK ("monthly_income_goals"."income_scope" IN ('own', 'all')),
	CONSTRAINT "monthly_income_goals_window_check" CHECK ("monthly_income_goals"."window_months" BETWEEN 1 AND 24)
);
--> statement-breakpoint
CREATE TABLE "savings_balance_goals" (
	"goal_id" text PRIMARY KEY NOT NULL,
	"goal_type" text NOT NULL,
	"target_cents" integer NOT NULL,
	"currency" text NOT NULL,
	CONSTRAINT "savings_balance_goals_type_check" CHECK ("savings_balance_goals"."goal_type" = 'savings-balance'),
	CONSTRAINT "savings_balance_goals_target_check" CHECK ("savings_balance_goals"."target_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "savings_rate_goals" (
	"goal_id" text PRIMARY KEY NOT NULL,
	"goal_type" text NOT NULL,
	"target_basis_points" integer NOT NULL,
	"income_scope" text NOT NULL,
	"window_months" integer NOT NULL,
	CONSTRAINT "savings_rate_goals_type_check" CHECK ("savings_rate_goals"."goal_type" = 'savings-rate'),
	CONSTRAINT "savings_rate_goals_target_check" CHECK ("savings_rate_goals"."target_basis_points" BETWEEN 1 AND 10000),
	CONSTRAINT "savings_rate_goals_scope_check" CHECK ("savings_rate_goals"."income_scope" IN ('own', 'all')),
	CONSTRAINT "savings_rate_goals_window_check" CHECK ("savings_rate_goals"."window_months" BETWEEN 1 AND 24)
);
--> statement-breakpoint
ALTER TABLE "baseline_items" DROP CONSTRAINT "baseline_items_label_unique";--> statement-breakpoint
ALTER TABLE "baseline_items" ADD COLUMN "goal_id" text;--> statement-breakpoint
DO $$
DECLARE
  legacy_goal_id text := '00000000-0000-4000-8000-000000000001';
  legacy_settings jsonb := '{}'::jsonb;
  legacy_raw text;
  legacy_basis text := 'essential-costs';
  legacy_buffer double precision := 10;
  legacy_window integer := 6;
  legacy_hourly integer := NULL;
  legacy_hours double precision := 20;
  migrated_at text := to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  base_currency text := 'EUR';
BEGIN
  SELECT value INTO legacy_raw FROM meta WHERE key = 'settings';
  IF legacy_raw IS NOT NULL THEN
    BEGIN
      legacy_settings := legacy_raw::jsonb;
    EXCEPTION WHEN others THEN
      legacy_settings := '{}'::jsonb;
    END;
  END IF;

  SELECT COALESCE((SELECT value FROM settings WHERE key = 'base_currency'), 'EUR')
    INTO base_currency;

  IF legacy_settings ->> 'goalMode' = 'lifestyle' THEN
    legacy_basis := 'current-spending';
  END IF;
  IF COALESCE(legacy_settings ->> 'bufferPct', '') ~ '^-?[0-9]+([.][0-9]+)?$' THEN
    legacy_buffer := GREATEST(0, LEAST(100, (legacy_settings ->> 'bufferPct')::double precision));
  END IF;
  IF COALESCE(legacy_settings ->> 'windowMonths', '') ~ '^-?[0-9]+([.][0-9]+)?$' THEN
    legacy_window := GREATEST(1, LEAST(24, ROUND((legacy_settings ->> 'windowMonths')::numeric)::integer));
  END IF;
  IF COALESCE(legacy_settings ->> 'hourlyRate', '') ~ '^[0-9]+([.][0-9]+)?$'
     AND (legacy_settings ->> 'hourlyRate')::double precision > 0 THEN
    legacy_hourly := ROUND((legacy_settings ->> 'hourlyRate')::numeric * 100)::integer;
  END IF;
  IF COALESCE(legacy_settings ->> 'hoursCapPerWeek', '') ~ '^[0-9]+([.][0-9]+)?$' THEN
    legacy_hours := GREATEST(0.01, LEAST(168, (legacy_settings ->> 'hoursCapPerWeek')::double precision));
  END IF;

  IF EXISTS (SELECT 1 FROM transactions)
     OR EXISTS (SELECT 1 FROM meta WHERE key = 'settings')
     OR EXISTS (SELECT 1 FROM baseline_items)
     OR EXISTS (SELECT 1 FROM budgets) THEN
    INSERT INTO goals (id, type, name, target_date, created_at, updated_at)
      VALUES (legacy_goal_id, 'financial-independence', 'Financial independence', NULL, migrated_at, migrated_at)
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO financial_independence_goals
      (goal_id, goal_type, basis, buffer_pct, window_months, hourly_rate_cents, hours_per_week)
      VALUES (
        legacy_goal_id,
        'financial-independence',
        legacy_basis,
        legacy_buffer,
        legacy_window,
        legacy_hourly,
        legacy_hours
      )
      ON CONFLICT (goal_id) DO NOTHING;
    UPDATE baseline_items SET goal_id = legacy_goal_id WHERE goal_id IS NULL;
  END IF;

  INSERT INTO goals (id, type, name, target_date, created_at, updated_at)
    SELECT
      'legacy-budget-' || md5(category),
      'category-spending-limit',
      INITCAP(REPLACE(category, '-', ' ')) || ' spending limit',
      NULL,
      migrated_at,
      migrated_at
    FROM budgets
    WHERE monthly_cents > 0
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO category_spending_goals
    (goal_id, goal_type, category, monthly_limit_cents, base_currency)
    SELECT
      'legacy-budget-' || md5(category),
      'category-spending-limit',
      category,
      monthly_cents,
      base_currency
    FROM budgets
    WHERE monthly_cents > 0
    ON CONFLICT (goal_id) DO NOTHING;

  DELETE FROM meta WHERE key = 'settings';
END $$;--> statement-breakpoint
ALTER TABLE "baseline_items" ALTER COLUMN "goal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "budgets" CASCADE;--> statement-breakpoint
ALTER TABLE "category_spending_goals" ADD CONSTRAINT "category_spending_goals_goal_fk" FOREIGN KEY ("goal_id","goal_type") REFERENCES "public"."goals"("id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_payoff_goals" ADD CONSTRAINT "debt_payoff_goals_goal_fk" FOREIGN KEY ("goal_id","goal_type") REFERENCES "public"."goals"("id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_fund_goals" ADD CONSTRAINT "emergency_fund_goals_goal_fk" FOREIGN KEY ("goal_id","goal_type") REFERENCES "public"."goals"("id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_independence_goals" ADD CONSTRAINT "financial_independence_goals_goal_fk" FOREIGN KEY ("goal_id","goal_type") REFERENCES "public"."goals"("id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_accounts" ADD CONSTRAINT "goal_accounts_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_income_goals" ADD CONSTRAINT "monthly_income_goals_goal_fk" FOREIGN KEY ("goal_id","goal_type") REFERENCES "public"."goals"("id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_balance_goals" ADD CONSTRAINT "savings_balance_goals_goal_fk" FOREIGN KEY ("goal_id","goal_type") REFERENCES "public"."goals"("id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_rate_goals" ADD CONSTRAINT "savings_rate_goals_goal_fk" FOREIGN KEY ("goal_id","goal_type") REFERENCES "public"."goals"("id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_items" ADD CONSTRAINT "baseline_items_goal_id_financial_independence_goals_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."financial_independence_goals"("goal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "baseline_items_goal_label_unique" ON "baseline_items" USING btree ("goal_id","label");--> statement-breakpoint
ALTER TABLE "baseline_items" ADD CONSTRAINT "baseline_items_monthly_check" CHECK ("baseline_items"."monthly_cents" > 0);