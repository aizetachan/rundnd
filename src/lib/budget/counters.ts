import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL, USER_SUB } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { dayBucketKey, minuteBucketKey } from "./config";

/**
 * Atomic counter operations for the budget system.
 *
 * Migrated from Postgres (INSERT ... ON CONFLICT DO UPDATE) to Firestore
 * (set merge + FieldValue.increment). Both flavors are atomic on the
 * server side; concurrent calls from the same user serialize correctly
 * without explicit locks.
 *
 * Layout (M0.5 mapping):
 *   users/{uid}/rateCounters/{minuteBucket} → { count, updatedAt }
 *   users/{uid}/costLedger/{dayBucket}      → { totalCostUsd, updatedAt }
 *   users/{uid}                             → { ..., dailyCostCapUsd }
 *
 * Note: Firestore docs only exist after the first write. `getCurrentRateCount`
 * and friends return 0 / null when the doc is missing — same null-safe
 * contract as the Postgres version.
 */

/** Atomic increment of the (user, current-minute) rate counter. Returns the NEW value. */
export async function incrementRateCounter(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const db = getFirebaseFirestore();
  const bucket = minuteBucketKey(now);
  const ref = db.collection(COL.users).doc(userId).collection(USER_SUB.rateCounters).doc(bucket);
  await ref.set(
    {
      count: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  // Firestore set() doesn't return the new value — re-read to mirror the
  // Postgres `RETURNING count` behavior. The cost (extra read) is the
  // tradeoff for not running our own counter shard logic; for the rate
  // limiter (6/min cap) this is fine.
  const snap = await ref.get();
  const count = snap.data()?.count;
  return typeof count === "number" ? count : 1;
}

/**
 * Read the current rate counter without mutating. Returns 0 when no doc
 * exists (i.e. no calls this minute).
 */
export async function getCurrentRateCount(userId: string, now: Date = new Date()): Promise<number> {
  const db = getFirebaseFirestore();
  const bucket = minuteBucketKey(now);
  const snap = await db
    .collection(COL.users)
    .doc(userId)
    .collection(USER_SUB.rateCounters)
    .doc(bucket)
    .get();
  const count = snap.data()?.count;
  return typeof count === "number" ? count : 0;
}

/**
 * Atomic increment of the (user, today) cost ledger by `deltaUsd`.
 * Returns the new cumulative total. Safe to call with delta=0.
 */
export async function incrementCostLedger(
  userId: string,
  deltaUsd: number,
  now: Date = new Date(),
): Promise<number> {
  const db = getFirebaseFirestore();
  const bucket = dayBucketKey(now);
  const ref = db.collection(COL.users).doc(userId).collection(USER_SUB.costLedger).doc(bucket);
  await ref.set(
    {
      totalCostUsd: FieldValue.increment(deltaUsd),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  const snap = await ref.get();
  const total = snap.data()?.totalCostUsd;
  return typeof total === "number" ? total : deltaUsd;
}

/**
 * Read the current-day cost total without mutating. Returns 0 when no
 * ledger doc exists for today.
 */
export async function getCurrentDayCost(userId: string, now: Date = new Date()): Promise<number> {
  const db = getFirebaseFirestore();
  const bucket = dayBucketKey(now);
  const snap = await db
    .collection(COL.users)
    .doc(userId)
    .collection(USER_SUB.costLedger)
    .doc(bucket)
    .get();
  const total = snap.data()?.totalCostUsd;
  return typeof total === "number" ? total : 0;
}

/**
 * Read the user's self-set daily cap. Returns null when the user doc
 * doesn't exist yet OR the field is unset/null.
 */
export async function getUserDailyCap(userId: string): Promise<number | null> {
  const db = getFirebaseFirestore();
  const snap = await db.collection(COL.users).doc(userId).get();
  const cap = snap.data()?.dailyCostCapUsd;
  return typeof cap === "number" ? cap : null;
}

/**
 * Set (or clear, by passing null) the user's daily cost cap. Cap = 0 is
 * a legitimate user choice — do NOT treat 0 and null as equivalent.
 *
 * Uses set merge so this works even when the user doc hasn't been
 * lazily created yet — pairs cleanly with the lazy-upsert flow in
 * getCurrentUser (Fase 3 sub 6).
 */
export async function setUserDailyCap(userId: string, capUsd: number | null): Promise<void> {
  const db = getFirebaseFirestore();
  await db.collection(COL.users).doc(userId).set(
    {
      dailyCostCapUsd: capUsd,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Snapshot of a user's current budget state — the shape returned by
 * /api/budget for the BudgetIndicator UI.
 */
export interface BudgetSnapshot {
  capUsd: number | null;
  usedUsd: number;
  percent: number | null;
  warn50: boolean;
  warn90: boolean;
  rateCount: number;
  rateCap: number;
  nextResetAt: string;
}

export async function getBudgetSnapshot(
  userId: string,
  now: Date = new Date(),
): Promise<BudgetSnapshot> {
  const [capUsd, usedUsd, rateCount] = await Promise.all([
    getUserDailyCap(userId),
    getCurrentDayCost(userId, now),
    getCurrentRateCount(userId, now),
  ]);
  const percent = capUsd === null || capUsd === 0 ? null : usedUsd / capUsd;
  const nextMidnight = new Date(now);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  return {
    capUsd,
    usedUsd,
    percent,
    warn50: percent !== null && percent >= 0.5,
    warn90: percent !== null && percent >= 0.9,
    rateCount,
    rateCap: (await import("./config")).getTurnRateCap(),
    nextResetAt: nextMidnight.toISOString(),
  };
}
