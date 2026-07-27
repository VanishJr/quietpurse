import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config: `npx drizzle-kit generate` diffs src/db/schema.ts against
 * the SQL migrations in ./drizzle and writes a new one. Migrations are applied
 * at backend startup (see src/db/index.ts), not by drizzle-kit.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://finto:finto@localhost:5432/finto',
  },
});
