import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts on purpose, and split into two projects whose
 * environment is bound to the filename: `*.test.ts` is `unit` (node, no DOM - the
 * pure functions: formatting, the slug dictionaries, how a refusal becomes a
 * sentence), `*.test.tsx` is `dom` (jsdom, React Testing Library, src/test/setup.ts).
 * A DOM test misnamed .test.ts therefore lands in `unit` and dies - at transform,
 * since JSX is not valid .ts, or on `document is not defined` without it - rather
 * than being silently not run.
 *
 * jsdom is not a browser: no layout, nothing from styles.css, no real navigation or
 * download, no chart rendering (recharts measures a 0x0 box). Those checks stay
 * manual - see "Verification has a hole" in AGENTS.md.
 */
export default defineConfig({
  test: {
    // A reading, not a gate: no threshold, and CI does not run it. Coverage is a
    // root option and not a project's. The harness under src/test/ is excluded by
    // name: vitest excludes the ROOT setup files by itself, and the dom project's
    // setup file is not one of those. What the include means is in
    // backend/test/SPEC.md, beside the backend's.
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/test/**'],
    },
    // TZ is set per project, not once at the top: a project does not inherit the
    // root test block. West of UTC on purpose: UTC is the one zone where a calendar
    // day read through a `Date` still lands on its own day, so a suite pinned there
    // cannot see that mistake.
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          env: { TZ: 'America/New_York' },
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
          env: { TZ: 'America/New_York' },
        },
      },
    ],
  },
});
