import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts on purpose: these tests cover the pure functions
 * only - formatting, the slug dictionaries, and how a failed request is turned
 * into a sentence. No DOM, no React plugin, so the run costs nothing and there is
 * no jsdom to keep honest.
 *
 * Components and screens are still unverified until a human clicks through them.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // fmtDate reads a UTC instant with local getters, so its output depends on the
    // machine's zone. Pinning the zone keeps the suite deterministic; it does not
    // make the dependency go away - see the date-only case in src/format.test.ts.
    env: { TZ: 'UTC' },
  },
});
