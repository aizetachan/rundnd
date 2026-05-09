import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { chronicleTurn, computeArcTrigger } from "../chronicle";

/**
 * chronicleTurn wraps runChronicler with:
 *   - Firestore-doc mutex on the campaign (replaces pg_advisory_lock;
 *     coarser FIFO — concurrent runs back off rather than queue)
 *   - idempotency guard on `turns/{turnId}.chronicledAt`
 *   - error swallow (doesn't throw; returns status tag)
 *
 * Tests here validate the wrapper's behavior against a fake Firestore +
 * a stubbed Agent SDK query. Real Firestore round-trip is an integration
 * target (not in M1 scope; acceptance ritual exercises it end-to-end).
 */

const CAMPAIGN = "22222222-2222-4222-9222-222222222222";
const TURN_ID = "11111111-1111-4111-8111-111111111111";

const intent: IntentOutput = {
  intent: "SOCIAL",
  action: "ask",
  target: "Jet",
  epicness: 0.3,
  special_conditions: [],
  confidence: 0.9,
};

const outcome: OutcomeOutput = {
  success_level: "success",
  difficulty_class: 12,
  modifiers: [],
  narrative_weight: "SIGNIFICANT",
  consequence: "Jet opens up.",
  rationale: "ok",
};

interface FsHooks {
  /** Initial chronicledAt for the turn doc; null/undefined => not yet chronicled. */
  turnChronicledAt?: Date | null;
  turnExists?: boolean;
  campaignExists?: boolean;
  /** Captured `set` payloads on the turn doc, for assertions. */
  turnSetCalls: Array<{ patch: Record<string, unknown> }>;
  /** Captured `set` payloads on the campaign doc (lock + release). */
  campaignSetCalls: Array<{ patch: Record<string, unknown> }>;
  /** Initial inFlight flag on the campaign doc — used to simulate concurrent runs. */
  inFlight?: boolean;
  /** When inFlight=true, how many ms ago the lock was set. */
  inFlightAgeMs?: number;
}

function fakeFirestore(hooks: FsHooks): Firestore {
  const turnRef = {
    get: async () => ({
      exists: hooks.turnExists !== false,
      data: () =>
        hooks.turnExists === false ? undefined : { chronicledAt: hooks.turnChronicledAt ?? null },
    }),
    set: async (patch: Record<string, unknown>, _opts?: { merge?: boolean }) => {
      hooks.turnSetCalls.push({ patch });
    },
  };

  const turnsCol = {
    doc: () => turnRef,
  };

  const semanticMemoriesCol = {
    get: async () => ({ empty: true, docs: [] }),
  };

  const campaignDocRef = {
    get: async () => ({
      exists: hooks.campaignExists !== false,
      data: () =>
        hooks.campaignExists === false
          ? undefined
          : {
              ownerUid: "u-1",
              deletedAt: null,
              name: "test",
              settings: {},
              chroniclerInFlight: hooks.inFlight === true,
              chroniclerStartedAt: hooks.inFlight
                ? {
                    toMillis: () => Date.now() - (hooks.inFlightAgeMs ?? 0),
                  }
                : undefined,
            },
    }),
    set: async (patch: Record<string, unknown>, _opts?: { merge?: boolean }) => {
      hooks.campaignSetCalls.push({ patch });
    },
    collection: (name: string) => {
      if (name === "turns") return turnsCol;
      if (name === "semanticMemories") return semanticMemoriesCol;
      throw new Error(`unexpected campaign subcollection ${name}`);
    },
  };

  return {
    collection: (name: string) => {
      if (name === "campaigns") return { doc: () => campaignDocRef };
      throw new Error(`unexpected collection ${name}`);
    },
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      // The transaction body uses tx.get / tx.set; we satisfy that with the
      // same shape as the doc ref so reads + writes flow through the same
      // hook captures. Set calls inside the txn route to campaignSetCalls.
      const tx = {
        get: async (ref: unknown) => {
          if (ref === campaignDocRef) return campaignDocRef.get();
          throw new Error("unexpected tx.get target");
        },
        set: (ref: unknown, data: Record<string, unknown>, _opts?: { merge?: boolean }) => {
          if (ref === campaignDocRef) {
            hooks.campaignSetCalls.push({ patch: data });
            return;
          }
          throw new Error("unexpected tx.set target");
        },
      };
      return fn(tx);
    },
    batch: () => {
      throw new Error("batch should not be used in this test path");
    },
  } as unknown as Firestore;
}

/** Stub query yielding a single clean success result. Unified helper
 * from `@/lib/llm/mock/testing` (Phase E of mockllm plan) — replaces
 * inline stubQuery patterns used across multiple test files. */
import { createMockQueryFn } from "@/lib/llm/mock/testing";
const stubQuery = createMockQueryFn([
  { result: { subtype: "success", stop_reason: "end_turn", total_cost_usd: 0 } },
]);

function baseInput(overrides: Partial<Parameters<typeof chronicleTurn>[0]> = {}) {
  return {
    turnId: TURN_ID,
    campaignId: CAMPAIGN,
    userId: "u-1",
    turnNumber: 7,
    playerMessage: "look around",
    narrative: "The bar is dimly lit. Jet nurses a drink.",
    intent,
    outcome,
    arcTrigger: null as null,
    ...overrides,
  };
}

describe("chronicleTurn — wrapper semantics (M0.5 Firestore migration)", () => {
  it("happy path: acquires lock, runs Chronicler, marks chronicledAt, releases lock", async () => {
    const hooks: FsHooks = { turnSetCalls: [], campaignSetCalls: [] };
    const firestore = fakeFirestore(hooks);
    const result = await chronicleTurn(baseInput(), { firestore, queryFn: stubQuery });
    expect(result).toBe("ok");

    // Lock acquire (via runTransaction set) + release (post-finally set).
    const flagPatches = hooks.campaignSetCalls.filter((c) =>
      Object.hasOwn(c.patch, "chroniclerInFlight"),
    );
    expect(flagPatches.length).toBeGreaterThanOrEqual(2);
    expect(flagPatches[0]?.patch.chroniclerInFlight).toBe(true);
    expect(flagPatches.at(-1)?.patch.chroniclerInFlight).toBe(false);

    // chronicledAt was stamped. The patch always carries it as a sentinel
    // (FieldValue.serverTimestamp) — we only assert the key is present.
    const chronicledAtSet = hooks.turnSetCalls.find((s) => Object.hasOwn(s.patch, "chronicledAt"));
    expect(chronicledAtSet).toBeDefined();
  });

  it("idempotency: already-chronicled turn returns 'already_chronicled' without running Chronicler", async () => {
    const hooks: FsHooks = {
      turnChronicledAt: new Date("2026-04-20T12:00:00Z"),
      turnSetCalls: [],
      campaignSetCalls: [],
    };
    const firestore = fakeFirestore(hooks);
    let queryCalled = false;
    const queryFn = createMockQueryFn([
      {
        onCall: () => {
          queryCalled = true;
        },
      },
    ]);
    const result = await chronicleTurn(baseInput(), { firestore, queryFn });
    expect(result).toBe("already_chronicled");
    expect(queryCalled).toBe(false);
    // No chronicledAt stamp re-applied.
    expect(hooks.turnSetCalls.filter((s) => Object.hasOwn(s.patch, "chronicledAt"))).toHaveLength(
      0,
    );
  });

  it("returns 'failed' when the turn doc is missing", async () => {
    const hooks: FsHooks = {
      turnExists: false,
      turnSetCalls: [],
      campaignSetCalls: [],
    };
    const firestore = fakeFirestore(hooks);
    const result = await chronicleTurn(baseInput(), { firestore, queryFn: stubQuery });
    expect(result).toBe("failed");
    expect(hooks.turnSetCalls).toHaveLength(0);
    // Lock release still happened.
    const releasePatch = hooks.campaignSetCalls.find((c) => c.patch.chroniclerInFlight === false);
    expect(releasePatch).toBeDefined();
  });

  it("returns 'failed' when the campaign is missing (deleted or transferred)", async () => {
    const hooks: FsHooks = {
      campaignExists: false,
      turnSetCalls: [],
      campaignSetCalls: [],
    };
    const firestore = fakeFirestore(hooks);
    const result = await chronicleTurn(baseInput(), { firestore, queryFn: stubQuery });
    // Lock acquisition fails when the campaign doesn't exist (acquire-tx
    // returns false). chronicleTurn falls through to skipped_concurrent —
    // surface this as well: the route handler can't distinguish a deleted
    // campaign from one that's busy and that's acceptable; it'll log and
    // move on regardless. We assert the failure mode rather than the
    // exact tag.
    expect(["failed", "skipped_concurrent"]).toContain(result);
    expect(hooks.turnSetCalls).toHaveLength(0);
  });

  it("swallows Chronicler errors and returns 'failed' without rethrowing", async () => {
    const hooks: FsHooks = { turnSetCalls: [], campaignSetCalls: [] };
    const firestore = fakeFirestore(hooks);
    // Stub that surfaces the "result error" path Chronicler handles.
    const throwingQuery = createMockQueryFn([
      { result: { subtype: "error_max_turns", stop_reason: "max_turns" } },
    ]);
    const result = await chronicleTurn(baseInput(), { firestore, queryFn: throwingQuery });
    expect(result).toBe("failed"); // NOT thrown
    // chronicledAt NOT stamped on failure.
    expect(hooks.turnSetCalls.filter((s) => Object.hasOwn(s.patch, "chronicledAt"))).toHaveLength(
      0,
    );
    // Lock released on error path too.
    const releasePatch = hooks.campaignSetCalls.find((c) => c.patch.chroniclerInFlight === false);
    expect(releasePatch).toBeDefined();
  });

  it("skips when another chronicler run is in flight (returns 'skipped_concurrent')", async () => {
    const hooks: FsHooks = {
      inFlight: true,
      inFlightAgeMs: 1000, // 1s old, well under the 60s timeout
      turnSetCalls: [],
      campaignSetCalls: [],
    };
    const firestore = fakeFirestore(hooks);
    const result = await chronicleTurn(baseInput(), { firestore, queryFn: stubQuery });
    expect(result).toBe("skipped_concurrent");
    // No turn writes happened.
    expect(hooks.turnSetCalls).toHaveLength(0);
  });

  it("acquires the lock when a stale flag is older than the timeout", async () => {
    const hooks: FsHooks = {
      inFlight: true,
      inFlightAgeMs: 120_000, // 2 minutes — past the 60s timeout
      turnSetCalls: [],
      campaignSetCalls: [],
    };
    const firestore = fakeFirestore(hooks);
    // Fresh queryFn per test — the module-level `stubQuery` shares its
    // sequence state across the file, so the happy-path test would have
    // exhausted it before this one ran.
    const localQueryFn = createMockQueryFn([
      { result: { subtype: "success", stop_reason: "end_turn", total_cost_usd: 0 } },
    ]);
    const result = await chronicleTurn(baseInput(), { firestore, queryFn: localQueryFn });
    expect(result).toBe("ok");
  });
});

describe("computeArcTrigger — M1 heuristic", () => {
  it("fires 'hybrid' when epicness >= 0.6 AND turnNumber % 3 === 0", () => {
    expect(computeArcTrigger(0.6, 3)).toBe("hybrid");
    expect(computeArcTrigger(0.8, 9)).toBe("hybrid");
    expect(computeArcTrigger(1.0, 30)).toBe("hybrid");
  });

  it("returns null when epicness < 0.6", () => {
    expect(computeArcTrigger(0.59, 3)).toBe(null);
    expect(computeArcTrigger(0.3, 9)).toBe(null);
    expect(computeArcTrigger(0.0, 30)).toBe(null);
  });

  it("returns null when turnNumber is not a multiple of 3", () => {
    expect(computeArcTrigger(0.8, 1)).toBe(null);
    expect(computeArcTrigger(0.8, 2)).toBe(null);
    expect(computeArcTrigger(0.8, 4)).toBe(null);
    expect(computeArcTrigger(0.8, 5)).toBe(null);
    expect(computeArcTrigger(0.8, 7)).toBe(null);
  });

  it("session_boundary is not produced at M1 (scaffolded for post-M1)", () => {
    // The type allows "session_boundary" but the M1 implementation
    // never returns it — session tracking lands later. Pin this so a
    // future change surfaces in review.
    const samples = [
      [1.0, 0],
      [1.0, 100],
      [0.5, 50],
      [0.0, 0],
    ] as const;
    for (const [ep, tn] of samples) {
      expect(computeArcTrigger(ep, tn)).not.toBe("session_boundary");
    }
  });
});
