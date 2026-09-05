import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // One worker process, files sequentially, shared module cache. Per-file
    // isolation forked a fresh process per test file, and every process compiled
    // the PGlite WASM bundle again - under memory pressure (Docker Desktop
    // running) workers died with native OOMs. One process = one PGlite.
    // Isolation between files is test/setup.ts, which is a setup file and so runs
    // once per test file, truncating every table before each one.
    isolate: false,
    fileParallelism: false,
    // Load PGlite through the native module loader instead of vitest's transform:
    // the transform re-parses its multi-megabyte bundle on every import graph
    // (V8 "Zone" OOM), the native cache keeps one copy per process.
    server: {
      deps: { external: [/@electric-sql\/pglite/] },
    },
  },
});
