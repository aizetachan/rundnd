import { z } from "zod";

/**
 * `users/{uid}` — the user's root document.
 *
 * Doc ID = Firebase Auth UID (text), preserving the same ID shape we used
 * with Clerk. Email comes from the verified Firebase token; getCurrentUser
 * lazy-upserts this row on first request after sign-in.
 *
 * `dailyCostCapUsd` mirrors the previous Postgres column. Null = no cap
 * (default; no platform-imposed ceiling). 0 is a legitimate user choice
 * (zero-spend day) distinct from null.
 */
export const FirestoreUser = z.object({
  id: z.string(), // Firebase Auth UID
  email: z.string().email(),
  createdAt: z.date(),
  deletedAt: z.date().nullable().optional(),
  dailyCostCapUsd: z.number().nullable().optional(),
});
export type FirestoreUser = z.infer<typeof FirestoreUser>;

/**
 * `users/{uid}/rateCounters/{minuteBucket}` — atomic rate-limit counter.
 *
 * `minuteBucket` is the doc ID (UTC ISO8601 minute, e.g. `2026-05-09T20:42Z`),
 * not stored as a field. Atomic increment via FieldValue.increment(1).
 * GC of historical buckets lands with billing work (M9).
 */
export const FirestoreRateCounter = z.object({
  count: z.number().int().nonnegative(),
  updatedAt: z.date(),
});
export type FirestoreRateCounter = z.infer<typeof FirestoreRateCounter>;

/**
 * `users/{uid}/costLedger/{dayBucket}` — per-day USD spend ledger.
 *
 * `dayBucket` is the doc ID (UTC `YYYY-MM-DD`). Append-only running total;
 * never decremented. The cap gate consults this when `dailyCostCapUsd != null`.
 */
export const FirestoreCostLedgerEntry = z.object({
  totalCostUsd: z.number().nonnegative(),
  updatedAt: z.date(),
});
export type FirestoreCostLedgerEntry = z.infer<typeof FirestoreCostLedgerEntry>;
