import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config: `npm run db:generate` diffs src/db/schema.ts against the SQL
 * migrations in ./drizzle and writes a new one. Migrations are applied at startup
 * (see src/db/index.ts), not by drizzle-kit, so no database credentials are needed
 * here.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
});
