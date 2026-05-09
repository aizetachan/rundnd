import { afterEach, beforeEach, vi } from "vitest";

// M0.5 Fase 3: workflow code consults NODE_ENV to skip Firestore lazy-init
// during tests (Drizzle mocks don't expect a real Firestore client). The
// .env.local in this repo sets NODE_ENV=development which leaks into tests
// when vitest is invoked locally, so we force the right value here.
// `as` cast required because @types/node marks NODE_ENV readonly.
(process.env as Record<string, string>).NODE_ENV = "test";

/**
 * Defensive global reset. Any test that mutates process.env should still
 * snapshot/restore in its own beforeEach/afterEach, but this ensures module
 * cache is always fresh and Vitest's env stubs don't leak.
 */
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});
