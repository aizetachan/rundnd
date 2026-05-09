#!/usr/bin/env node
/**
 * Eval harness — deprecated under M0.5 Firebase migration.
 *
 * The pre-M0.5 harness seeded a scratch campaign + character + profile
 * via Drizzle, ran `runTurn` against MockLLM, and tore the rows down
 * after each scenario. The Drizzle schema, db-scratch helper, and the
 * `users` / `campaigns` / `turns` Postgres tables are all gone now —
 * see `docs/plans/M0.5-firebase-migration.md`.
 *
 * Rewriting the harness on top of Firestore (or, more likely, the
 * Firestore emulator) is its own piece of work and was not included in
 * the M0.5 closeout. The deterministic aggregator + summarize helpers
 * in `evals/aggregate.ts` are still tested on their own (see
 * `evals/run.test.ts`); only the seed + run loop is offline.
 *
 * To re-enable:
 *   1. Replace `seedScratchCampaign` (`evals/db-scratch.ts`) with a
 *      Firestore-emulator-backed seed that writes to
 *      `campaigns/{id}` + `campaigns/{id}/characters/{id}` +
 *      `profiles/{slug}` (or upserts the profile from a YAML fixture).
 *   2. Replace the `getDb()` references below with
 *      `getFirebaseFirestore()` (the lazy admin singleton).
 *   3. Wire teardown to delete the scratch campaign's subcollections
 *      via a recursive delete (Admin SDK has `firestore.recursiveDelete`).
 *
 * Until then this script is a no-op so `pnpm evals` doesn't pretend
 * to do something it can't.
 */

console.warn(
  "[eval] harness is offline pending the M0.5 Firestore rewrite. See evals/run.ts for the migration checklist.",
);
process.exit(0);
