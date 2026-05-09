/**
 * `seedScratchCampaign` — deprecated under M0.5 Firebase migration.
 *
 * This module previously wrote scratch users / profiles / campaigns /
 * characters to Postgres via Drizzle so the eval harness could exercise
 * `runTurn` end-to-end. The Drizzle schema and `getDb()` are gone now;
 * the harness itself is a no-op (see `evals/run.ts` for the rewrite
 * checklist).
 *
 * Kept as an empty file to preserve the import path until the harness
 * is rewritten against Firestore. Anything that imports from here will
 * need to be migrated alongside the rewrite.
 */
export {};
