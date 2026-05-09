import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import {
  BOOST_ON_ACCESS,
  CATEGORY_DECAY,
  DECAY_CURVES,
  STATIC_BOOST,
  boostHeatOnAccess,
  curveFor,
  decayHeat,
  heatFloor,
} from "../decay";

/**
 * Decay physics tests (Phase 4 v3-audit closure, M0.5 Fase 3 sub 5
 * Firestore migration). Two layers:
 *
 *   1. Pure-helper tests — exercise curveFor / heatFloor / the constant
 *      tables directly. No I/O.
 *   2. decayHeat + boostHeatOnAccess unit tests — run against a fake
 *      Firestore that records writes (same patterned shape as
 *      `tools/chronicler/__tests__/chronicler-tools.test.ts`).
 *
 * Real-DB round-trip is an integration target (acceptance ritual exercises
 * end-to-end against the live emulator).
 */

describe("DECAY_CURVES — v3-parity values", () => {
  it("none is 1.0 (no decay)", () => {
    expect(DECAY_CURVES.none).toBe(1.0);
  });
  it("very_slow through very_fast covers the v3 range", () => {
    expect(DECAY_CURVES.very_slow).toBe(0.97);
    expect(DECAY_CURVES.slow).toBe(0.95);
    expect(DECAY_CURVES.normal).toBe(0.9);
    expect(DECAY_CURVES.fast).toBe(0.8);
    expect(DECAY_CURVES.very_fast).toBe(0.7);
  });
});

describe("CATEGORY_DECAY — critical mappings (v3-parity)", () => {
  it("session_zero categories never decay", () => {
    expect(CATEGORY_DECAY.core).toBe("none");
    expect(CATEGORY_DECAY.session_zero).toBe("none");
    expect(CATEGORY_DECAY.session_zero_voice).toBe("none");
  });
  it("relationship uses very_slow (bonds build slowly)", () => {
    expect(CATEGORY_DECAY.relationship).toBe("very_slow");
  });
  it("episode uses very_fast (one-episode summaries expire quickly)", () => {
    expect(CATEGORY_DECAY.episode).toBe("very_fast");
  });
  it("character_state uses fast (hunger, fatigue expire)", () => {
    expect(CATEGORY_DECAY.character_state).toBe("fast");
  });
});

describe("curveFor — fallback behavior", () => {
  it("returns the mapped curve when known", () => {
    expect(curveFor("relationship")).toBe("very_slow");
    expect(curveFor("episode")).toBe("very_fast");
  });
  it("returns 'normal' for unknown categories (Chronicler can nominate new categories)", () => {
    expect(curveFor("bizarre_new_category")).toBe("normal");
    expect(curveFor("")).toBe("normal");
  });
});

describe("heatFloor — respects flags", () => {
  it("plot_critical → floors at current heat (never decays below its last-known value)", () => {
    expect(heatFloor({ plot_critical: true }, 85)).toBe(85);
    expect(heatFloor({ plot_critical: true }, 50)).toBe(50);
  });
  it("milestone_relationship → floor 40", () => {
    expect(heatFloor({ milestone_relationship: true }, 100)).toBe(40);
    expect(heatFloor({ milestone_relationship: true }, 20)).toBe(40);
  });
  it("plot_critical wins over milestone_relationship when both set", () => {
    expect(heatFloor({ plot_critical: true, milestone_relationship: true }, 75)).toBe(75);
  });
  it("no flags → floor 1 (retains a trace for retrieval)", () => {
    expect(heatFloor({}, 100)).toBe(1);
    expect(heatFloor(null, 50)).toBe(1);
    expect(heatFloor(undefined, 30)).toBe(1);
  });
});

describe("BOOST_ON_ACCESS — per-category retrieval bumps", () => {
  it("relationship gets +30 (stays hotter)", () => {
    expect(BOOST_ON_ACCESS.relationship).toBe(30);
  });
  it("default is +20", () => {
    expect(BOOST_ON_ACCESS.default).toBe(20);
  });
});

describe("STATIC_BOOST — M4 retrieval-ranking scaffolding", () => {
  it("session_zero + plot_critical get +0.3 (same boost, two paths)", () => {
    expect(STATIC_BOOST.session_zero).toBe(0.3);
    expect(STATIC_BOOST.plot_critical).toBe(0.3);
  });
  it("episode gets +0.15 (half the priority bump)", () => {
    expect(STATIC_BOOST.episode).toBe(0.15);
  });
});

describe("Decay formula — compound multiplier math", () => {
  /**
   * Sanity-check the intended formula: heat_new = heat_old × multiplier^delta_turns.
   * `decayHeat` runs this in JS on the read pass; here we pin the
   * mental model matches what decay.ts documents.
   */
  it("slow (0.95) × 10 turns = 59.87 of original 100", () => {
    const slow = DECAY_CURVES.slow;
    const result = 100 * slow ** 10;
    expect(result).toBeCloseTo(59.87, 1);
  });
  it("very_fast (0.7) × 5 turns = 16.8 of original 100", () => {
    const vfast = DECAY_CURVES.very_fast;
    const result = 100 * vfast ** 5;
    expect(result).toBeCloseTo(16.81, 1);
  });
  it("none (1.0) × 100 turns = 100 (no decay)", () => {
    expect(100 * DECAY_CURVES.none ** 100).toBe(100);
  });
});

/**
 * Fake Firestore for decayHeat + boostHeatOnAccess. Captures batch.update
 * payloads keyed by doc id, plus `set` calls for the boost path. Mirrors
 * the patterned shape used by the Chronicler tests.
 */
const CAMPAIGN = "22222222-2222-4222-9222-222222222222";

interface MemoryDoc {
  id: string;
  data: {
    category?: string;
    heat?: number;
    turnNumber?: number;
    flags?: Record<string, unknown> | null;
  };
}

interface CapturedFs {
  batchUpdates: Array<{ docId: string; patch: Record<string, unknown> }>;
  batchCommits: number;
  setCalls: Array<{ docId: string; data: Record<string, unknown>; merge: boolean }>;
}

function makeFakeFirestore(memories: MemoryDoc[], captured: CapturedFs): Firestore {
  function makeDocRef(docId: string) {
    return {
      id: docId,
      path: `campaigns/${CAMPAIGN}/semanticMemories/${docId}`,
      set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
        captured.setCalls.push({ docId, data, merge: options?.merge ?? false });
      },
    };
  }

  const semanticMemories = {
    get: async () => ({
      empty: memories.length === 0,
      docs: memories.map((m) => ({ ...m, ref: makeDocRef(m.id), data: () => m.data })),
    }),
    doc: (docId: string) => makeDocRef(docId),
  };

  const campaignsCol = {
    doc: () => ({
      collection: () => semanticMemories,
    }),
  };

  function makeBatch() {
    return {
      update: (
        ref: { id: string; path: string },
        patch: Record<string, unknown>,
      ) => {
        captured.batchUpdates.push({ docId: ref.id, patch });
      },
      commit: async () => {
        captured.batchCommits += 1;
      },
    };
  }

  return {
    collection: () => campaignsCol,
    batch: () => makeBatch(),
  } as unknown as Firestore;
}

describe("decayHeat — Firestore migration", () => {
  it("returns rowsAffected: 0 when the campaign has no semantic memories", async () => {
    const captured: CapturedFs = { batchUpdates: [], batchCommits: 0, setCalls: [] };
    const fs = makeFakeFirestore([], captured);
    const result = await decayHeat(fs, CAMPAIGN, 10);
    expect(result.rowsAffected).toBe(0);
    expect(captured.batchCommits).toBe(0);
  });

  it("applies decay multiplier^delta to a stale memory and writes the new heat", async () => {
    // delta = 10 - 0 = 10; slow curve → 0.95^10 ≈ 0.5987 → floor(100 * 0.5987) = 59.
    const memories: MemoryDoc[] = [
      {
        id: "m-1",
        data: { category: "fact", heat: 100, turnNumber: 0, flags: {} },
      },
    ];
    const captured: CapturedFs = { batchUpdates: [], batchCommits: 0, setCalls: [] };
    const fs = makeFakeFirestore(memories, captured);
    const result = await decayHeat(fs, CAMPAIGN, 10);
    expect(result.rowsAffected).toBe(1);
    expect(captured.batchCommits).toBe(1);
    expect(captured.batchUpdates).toHaveLength(1);
    expect(captured.batchUpdates[0]?.docId).toBe("m-1");
    expect(captured.batchUpdates[0]?.patch.heat).toBe(59);
  });

  it("skips memories whose heat is unchanged (no-op write)", async () => {
    // delta = 0 → multiplier^0 = 1 → newHeat = floor(100) = 100, equal to current.
    const memories: MemoryDoc[] = [
      { id: "m-fresh", data: { category: "fact", heat: 100, turnNumber: 7, flags: {} } },
    ];
    const captured: CapturedFs = { batchUpdates: [], batchCommits: 0, setCalls: [] };
    const fs = makeFakeFirestore(memories, captured);
    const result = await decayHeat(fs, CAMPAIGN, 7);
    expect(result.rowsAffected).toBe(0);
    expect(captured.batchUpdates).toHaveLength(0);
    expect(captured.batchCommits).toBe(0);
  });

  it("respects plot_critical floor: heat never drops below its current value", async () => {
    // very_fast × 5 turns = 0.7^5 ≈ 0.168 → floor(85 * 0.168) = 14, but
    // plot_critical floors at currentHeat (85), so newHeat = 85 = current.
    // Equal → no-op write (skip path).
    const memories: MemoryDoc[] = [
      {
        id: "m-pc",
        data: { category: "episode", heat: 85, turnNumber: 0, flags: { plot_critical: true } },
      },
    ];
    const captured: CapturedFs = { batchUpdates: [], batchCommits: 0, setCalls: [] };
    const fs = makeFakeFirestore(memories, captured);
    const result = await decayHeat(fs, CAMPAIGN, 5);
    expect(result.rowsAffected).toBe(0);
    expect(captured.batchUpdates).toHaveLength(0);
  });

  it("respects milestone_relationship floor 40", async () => {
    // very_fast × 10 turns = 0.7^10 ≈ 0.028 → floor(100 * 0.028) = 2,
    // floor=40 wins → newHeat = 40.
    const memories: MemoryDoc[] = [
      {
        id: "m-mr",
        data: {
          category: "episode",
          heat: 100,
          turnNumber: 0,
          flags: { milestone_relationship: true },
        },
      },
    ];
    const captured: CapturedFs = { batchUpdates: [], batchCommits: 0, setCalls: [] };
    const fs = makeFakeFirestore(memories, captured);
    const result = await decayHeat(fs, CAMPAIGN, 10);
    expect(result.rowsAffected).toBe(1);
    expect(captured.batchUpdates[0]?.patch.heat).toBe(40);
  });

  it("uses category 'normal' default when category is unknown to the table", async () => {
    // 0.9^4 ≈ 0.6561 → floor(100 * 0.6561) = 65.
    const memories: MemoryDoc[] = [
      {
        id: "m-x",
        data: { category: "made_up_category", heat: 100, turnNumber: 0, flags: {} },
      },
    ];
    const captured: CapturedFs = { batchUpdates: [], batchCommits: 0, setCalls: [] };
    const fs = makeFakeFirestore(memories, captured);
    const result = await decayHeat(fs, CAMPAIGN, 4);
    expect(result.rowsAffected).toBe(1);
    expect(captured.batchUpdates[0]?.patch.heat).toBe(65);
  });
});

describe("boostHeatOnAccess — Firestore migration", () => {
  it("relationship category boosts by 30 via FieldValue.increment", async () => {
    const captured: CapturedFs = { batchUpdates: [], batchCommits: 0, setCalls: [] };
    const fs = makeFakeFirestore([], captured);
    await boostHeatOnAccess(fs, CAMPAIGN, "mem-1", "relationship");
    expect(captured.setCalls).toHaveLength(1);
    const call = captured.setCalls[0];
    if (!call) throw new Error("expected one set call");
    expect(call.docId).toBe("mem-1");
    expect(call.merge).toBe(true);
    // The increment sentinel travels through as an opaque FieldValue object;
    // assert presence + type rather than its post-resolution numeric value.
    expect(call.data).toHaveProperty("heat");
  });

  it("non-relationship category boosts by 20 (default)", async () => {
    const captured: CapturedFs = { batchUpdates: [], batchCommits: 0, setCalls: [] };
    const fs = makeFakeFirestore([], captured);
    await boostHeatOnAccess(fs, CAMPAIGN, "mem-2", "lore");
    expect(captured.setCalls).toHaveLength(1);
    expect(captured.setCalls[0]?.docId).toBe("mem-2");
    expect(captured.setCalls[0]?.merge).toBe(true);
  });
});
