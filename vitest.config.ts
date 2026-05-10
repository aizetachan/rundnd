import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "evals/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Fail fast on CI so a broken test doesn't eat minutes.
    bail: process.env.CI ? 1 : 0,
    // Vitest's default 5s timeout is tight for our integration-flavored
    // tests (runTurn cost aggregation, override persistence, register_npc).
    // First-test-in-file warm-up + vi.resetModules() cycles routinely
    // cross 5s under suite load. Bumping to 30s eliminates the flakiness
    // both M2 retros documented; tests that genuinely deadlock still
    // fail loud well within the 30s ceiling.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
