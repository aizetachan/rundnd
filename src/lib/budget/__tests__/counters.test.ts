import { describe, expect, it, vi } from "vitest";

/**
 * Mocked counters tests — verify the Firestore call shapes and fallback
 * semantics without a running Firestore. Real-DB concurrency / atomicity
 * tests would live alongside this file as `counters.real-db.test.ts`,
 * gated behind `FIRESTORE_EMULATOR_HOST` so they only run when the
 * emulator is up.
 *
 * The mock pattern: `getFirebaseFirestore()` returns an object whose
 * `collection(...).doc(...).collection(...).doc(...)` chain ends in a
 * stub with `set` and `get` methods. Each test wires the leaf to whatever
 * data shape it wants to assert against.
 */

interface DocStub {
  set: (...args: unknown[]) => Promise<unknown>;
  get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
}

function makeFakeFirestore(leaf: DocStub): {
  collection: () => unknown;
} {
  const docFn = () => ({
    collection: () => ({ doc: () => leaf }),
    set: leaf.set,
    get: leaf.get,
  });
  return {
    collection: () => ({ doc: docFn }),
  };
}

describe("counters — increment return shapes", () => {
  it("incrementRateCounter returns the count read back after set+merge", async () => {
    const sets: unknown[] = [];
    vi.resetModules();
    vi.doMock("@/lib/firebase/admin", () => ({
      getFirebaseFirestore: () =>
        makeFakeFirestore({
          set: async (data) => {
            sets.push(data);
            return undefined;
          },
          get: async () => ({ exists: true, data: () => ({ count: 5 }) }),
        }),
    }));
    const { incrementRateCounter } = await import("../counters");
    const result = await incrementRateCounter("user-1", new Date(Date.UTC(2026, 3, 22, 15, 42)));
    expect(result).toBe(5);
    expect(sets).toHaveLength(1);
  });

  it("incrementRateCounter falls back to 1 when the doc has no count", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebase/admin", () => ({
      getFirebaseFirestore: () =>
        makeFakeFirestore({
          set: async () => undefined,
          get: async () => ({ exists: false, data: () => undefined }),
        }),
    }));
    const { incrementRateCounter } = await import("../counters");
    const result = await incrementRateCounter("user-1");
    expect(result).toBe(1);
  });

  it("incrementCostLedger returns the running total from the read-back", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebase/admin", () => ({
      getFirebaseFirestore: () =>
        makeFakeFirestore({
          set: async () => undefined,
          get: async () => ({ exists: true, data: () => ({ totalCostUsd: 1.234567 }) }),
        }),
    }));
    const { incrementCostLedger } = await import("../counters");
    const result = await incrementCostLedger("user-1", 0.5);
    expect(result).toBeCloseTo(1.234567, 5);
  });

  it("getCurrentRateCount returns 0 when no doc exists", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebase/admin", () => ({
      getFirebaseFirestore: () =>
        makeFakeFirestore({
          set: async () => undefined,
          get: async () => ({ exists: false, data: () => undefined }),
        }),
    }));
    const { getCurrentRateCount } = await import("../counters");
    const count = await getCurrentRateCount("user-1");
    expect(count).toBe(0);
  });

  it("getCurrentDayCost returns 0 when no ledger doc exists", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebase/admin", () => ({
      getFirebaseFirestore: () =>
        makeFakeFirestore({
          set: async () => undefined,
          get: async () => ({ exists: false, data: () => undefined }),
        }),
    }));
    const { getCurrentDayCost } = await import("../counters");
    const cost = await getCurrentDayCost("user-1");
    expect(cost).toBe(0);
  });

  it("getUserDailyCap returns null when the field is null", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebase/admin", () => ({
      getFirebaseFirestore: () =>
        makeFakeFirestore({
          set: async () => undefined,
          get: async () => ({ exists: true, data: () => ({ dailyCostCapUsd: null }) }),
        }),
    }));
    const { getUserDailyCap } = await import("../counters");
    const cap = await getUserDailyCap("user-1");
    expect(cap).toBeNull();
  });

  it("getUserDailyCap returns 0 (not null) when user set cap = 0", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebase/admin", () => ({
      getFirebaseFirestore: () =>
        makeFakeFirestore({
          set: async () => undefined,
          get: async () => ({ exists: true, data: () => ({ dailyCostCapUsd: 0 }) }),
        }),
    }));
    const { getUserDailyCap } = await import("../counters");
    const cap = await getUserDailyCap("user-1");
    expect(cap).toBe(0);
  });

  it("getUserDailyCap returns null when the user doc doesn't exist", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebase/admin", () => ({
      getFirebaseFirestore: () =>
        makeFakeFirestore({
          set: async () => undefined,
          get: async () => ({ exists: false, data: () => undefined }),
        }),
    }));
    const { getUserDailyCap } = await import("../counters");
    const cap = await getUserDailyCap("user-1");
    expect(cap).toBeNull();
  });

  it("setUserDailyCap forwards null/0/10 verbatim to the doc (Firestore stores numbers natively)", async () => {
    const sets: Record<string, unknown>[] = [];
    vi.resetModules();
    vi.doMock("@/lib/firebase/admin", () => ({
      getFirebaseFirestore: () =>
        makeFakeFirestore({
          set: async (data) => {
            sets.push(data as Record<string, unknown>);
            return undefined;
          },
          get: async () => ({ exists: false, data: () => undefined }),
        }),
    }));
    const { setUserDailyCap } = await import("../counters");
    await setUserDailyCap("user-1", null);
    await setUserDailyCap("user-1", 0);
    await setUserDailyCap("user-1", 10);
    expect(sets[0]?.dailyCostCapUsd).toBeNull();
    expect(sets[1]?.dailyCostCapUsd).toBe(0);
    expect(sets[2]?.dailyCostCapUsd).toBe(10);
  });
});
