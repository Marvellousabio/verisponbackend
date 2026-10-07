import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/app.test.ts calls vi.resetModules() and re-imports the whole
    // application module graph on each case, so it pays a full Express + pg +
    // multer + zod transform. On a cold cache that exceeded vitest's 5s default
    // and failed the run for reasons that had nothing to do with the assertion.
    // The transform is a one-off cost per run, so the ceiling is generous rather
    // than tight enough to catch a genuine hang.
    testTimeout: 20_000,

    // Each worker is a forked Node process that loads the full module graph of
    // whatever it runs, so app.test.ts and object-storage.test.ts together pull
    // in Express, pg, multer, zod and the Cloudinary SDK. On Windows the
    // default one-fork-per-core fan-out exhausted the process stack budget and
    // workers died with STATUS_STACK_BUFFER_OVERRUN (3221226505) during startup
    // — a crash in the harness, not a failure of any assertion. Two workers is
    // plenty for a suite this size.
    maxWorkers: 2,
    minWorkers: 1,
  },
});