import { describe, expect, it } from "vitest";
import type { AidmToolContext } from "../../index";

/**
 * Per-tool unit tests for the Chronicler write tools. Covers:
 *   - Zod input schema catches malformed args
 *   - execute() issues the right Firestore actions (set / add / update,
 *     including the transaction variants) with the expected values
 *   - Zod output schema catches malformed returns from the data layer
 *
 * We don't exercise real Firestore here — registry auth + span wrapping
 * are covered by `src/lib/tools/__tests__/registry.test.ts`, and the
 * real DB round-trip is exercised by the turn-pipeline integration when
 * Chronicler is wired via `after()`.
 *
 * NOTE: `tests/setup.ts` runs `vi.resetModules()` in `beforeEach`, so we
 * dynamic-import the registry per test. A top-level `import { invokeTool }`
 * would bind to a pre-reset module whose registry is empty at test time.
 * Same pattern as `registry.test.ts`'s "real tools" describe.
 */

const UUID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-9222-222222222222";
const NPC_ID = "33333333-3333-4333-8333-333333333333";

interface CapturedWrites {
  sets: Array<{ path: string; data: Record<string, unknown>; merge: boolean }>;
  updates: Array<{ path: string; data: Record<string, unknown> }>;
  adds: Array<{ path: string; data: Record<string, unknown> }>;
  transactionRuns: number;
}

interface FakeOpts {
  /** When `null`, the campaign doc does not exist (auth fails). When omitted, defaults to a valid campaign owned by `u-1`. */
  campaign?: { ownerUid?: string; settings?: unknown; deletedAt?: Date | null } | null;
  /**
   * Pre-existing docs in subcollections, keyed by subcollection name.
   * Each entry's `id` is the doc id (used by `.doc(id).get()`); `data` is
   * what `.data()` returns for both single-doc reads and query results.
   */
  subcollectionDocs?: Record<string, Array<{ id: string; data: Record<string, unknown> }>>;
}

async function freshRegistry() {
  return await import("../../index");
}

function makeCaptured(): CapturedWrites {
  return { sets: [], updates: [], adds: [], transactionRuns: 0 };
}

/**
 * Build a fake Firestore that:
 *   - Returns the campaign doc for `authorizeCampaignAccess` (top-level
 *     `campaigns/{id}` read).
 *   - Returns pre-seeded docs in subcollections via `.doc(id).get()` and
 *     query chains (`.where().orderBy().limit().get()`).
 *   - Captures `.set`, `.update`, `.add` (including those issued inside
 *     a `runTransaction(callback)`).
 *   - Supports atomic ops by storing whatever sentinel `FieldValue.*`
 *     returns; tests assert via the captured payload, not the resolved
 *     post-increment value (with the exception of adjust_spotlight_debt
 *     which reads after write — covered with a per-test seed).
 */
function makeFakeFirestore(
  captured: CapturedWrites,
  opts: FakeOpts = {},
): AidmToolContext["firestore"] {
  const campaignMissing = opts.campaign === null;
  const campaignData = campaignMissing
    ? undefined
    : {
        ownerUid: opts.campaign?.ownerUid ?? "u-1",
        deletedAt: opts.campaign?.deletedAt ?? null,
        name: "test",
        settings: opts.campaign?.settings ?? {},
        phase: "playing",
        profileRefs: [],
        createdAt: new Date(),
      };

  const subDocs = opts.subcollectionDocs ?? {};

  /**
   * Build a doc ref under a campaign subcollection. The path string is what
   * captured writes assert against (e.g. `campaigns/<id>/npcs/<docId>`).
   */
  function makeSubDocRef(subcollectionName: string, docId: string) {
    const path = `campaigns/${CAMPAIGN}/${subcollectionName}/${docId}`;
    const seeded = subDocs[subcollectionName]?.find((d) => d.id === docId);
    const ref = {
      id: docId,
      path,
      get: async () => ({
        id: docId,
        exists: seeded !== undefined,
        data: () => seeded?.data,
      }),
      set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
        captured.sets.push({ path, data, merge: options?.merge ?? false });
      },
      update: async (data: Record<string, unknown>) => {
        captured.updates.push({ path, data });
      },
      collection: () => makeSubcollection("__nested__"),
    };
    return ref;
  }

  /**
   * Build a subcollection handle under `campaigns/{CAMPAIGN}/<name>`.
   * Supports doc lookups, query chains, add(), and count().
   */
  function makeSubcollection(name: string) {
    const seededDocs = subDocs[name] ?? [];
    const queryDocs = seededDocs.map((d) => ({
      id: d.id,
      data: () => d.data,
      ref: makeSubDocRef(name, d.id),
    }));

    // Build a query chain that honors `.limit(n)` — trigger_compactor
    // relies on it to cap the oldest-N fetch. Order/where filters are
    // not enforced (tests don't depend on filter semantics; they seed
    // exactly the rows they expect to read), but limit truncates the
    // result set so the slice the tool returns matches expectations.
    function makeQuery(currentLimit: number | null): Record<string, unknown> {
      const q: Record<string, unknown> = {
        where: () => makeQuery(currentLimit),
        orderBy: () => makeQuery(currentLimit),
        limit: (n: number) => makeQuery(n),
        get: async () => {
          const sliced = currentLimit === null ? queryDocs : queryDocs.slice(0, currentLimit);
          return { empty: sliced.length === 0, docs: sliced };
        },
        count: () => ({
          get: async () => ({ data: () => ({ count: queryDocs.length }) }),
        }),
      };
      return q;
    }
    const queryShape = makeQuery(null);

    return {
      ...queryShape,
      doc: (docId: string) => makeSubDocRef(name, docId),
      add: async (data: Record<string, unknown>) => {
        const path = `campaigns/${CAMPAIGN}/${name}`;
        captured.adds.push({ path, data });
        const newId = `${name}-new-${captured.adds.length}`;
        return makeSubDocRef(name, newId);
      },
    };
  }

  const campaignDocRef = {
    id: CAMPAIGN,
    path: `campaigns/${CAMPAIGN}`,
    get: async () => ({
      id: CAMPAIGN,
      exists: !campaignMissing,
      data: () => campaignData,
    }),
    collection: (sub: string) => makeSubcollection(sub),
  };

  /**
   * Transaction emulator: tx.get/.set/.update route through the same
   * ref bookkeeping as the non-tx path. Tests don't distinguish — set
   * inside a transaction shows up in `captured.sets` like any other.
   */
  async function runTransaction<T>(
    callback: (tx: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (
        ref: { path: string },
        data: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => void;
      update: (ref: { path: string }, data: Record<string, unknown>) => void;
    }) => Promise<T>,
  ): Promise<T> {
    captured.transactionRuns += 1;
    const tx = {
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (
        ref: { path: string },
        data: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => {
        captured.sets.push({ path: ref.path, data, merge: options?.merge ?? false });
      },
      update: (ref: { path: string }, data: Record<string, unknown>) => {
        captured.updates.push({ path: ref.path, data });
      },
    };
    return await callback(tx);
  }

  return {
    collection: (name: string) => {
      if (name === "campaigns") {
        return {
          doc: () => campaignDocRef,
        };
      }
      // Top-level non-campaign collection — none used by chronicler tools,
      // but return an empty shape rather than crashing.
      return {
        doc: () => ({
          get: async () => ({ exists: false, data: () => undefined }),
        }),
      };
    },
    runTransaction,
  } as unknown as AidmToolContext["firestore"];
}

function makeCtx(firestore: AidmToolContext["firestore"]): AidmToolContext {
  return {
    campaignId: CAMPAIGN,
    userId: "u-1",
    firestore,
  };
}

describe("Chronicler tools", () => {
  describe("register_npc", () => {
    it("inserts with defaults when fields are omitted; returns created=true", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {});
      const out = await mod.invokeTool(
        "register_npc",
        { name: "Jet Black", first_seen_turn: 1, last_seen_turn: 1 },
        makeCtx(fs),
      );
      expect(out).toMatchObject({ created: true });
      expect((out as { id: string }).id).toMatch(/.+/);
      // The set landed in the npcs subcollection within a transaction.
      expect(captured.transactionRuns).toBe(1);
      expect(captured.sets).toHaveLength(1);
      const set = captured.sets[0];
      if (!set) throw new Error("expected one set");
      expect(set.path).toMatch(/\/npcs\//);
      const v = set.data;
      expect(v.campaignId).toBe(CAMPAIGN);
      expect(v.name).toBe("Jet Black");
      expect(v.role).toBe("acquaintance");
      expect(v.powerTier).toBe("T10");
      expect(v.isTransient).toBe(false);
      expect(v.goals).toEqual([]);
      expect(v.knowledgeTopics).toEqual({});
    });

    it("returns created=false + existing id on unique-conflict (doc already exists)", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      // Pre-seed an NPC at the deterministic doc id `safeNameId("Jet Black")`
      // = "jet-black".
      const fs = makeFakeFirestore(captured, {
        subcollectionDocs: { npcs: [{ id: "jet-black", data: { name: "Jet Black" } }] },
      });
      const out = await mod.invokeTool(
        "register_npc",
        { name: "Jet Black", first_seen_turn: 1, last_seen_turn: 1 },
        makeCtx(fs),
      );
      expect(out).toMatchObject({ created: false });
      expect((out as { id: string }).id).toBe("jet-black");
      // Crucially, no insert fired — the pre-seeded doc was respected.
      expect(captured.sets).toHaveLength(0);
    });

    it("rejects empty name (Zod)", async () => {
      const mod = await freshRegistry();
      const fs = makeFakeFirestore(makeCaptured(), {});
      await expect(
        mod.invokeTool(
          "register_npc",
          { name: "", first_seen_turn: 1, last_seen_turn: 1 },
          makeCtx(fs),
        ),
      ).rejects.toThrow();
    });
  });

  describe("update_npc", () => {
    it("updates fields by id; omitted fields untouched", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      // Pre-seed the target doc — update_npc reads with .get() before set.
      const fs = makeFakeFirestore(captured, {
        subcollectionDocs: { npcs: [{ id: NPC_ID, data: { name: "Jet" } }] },
      });
      const out = await mod.invokeTool(
        "update_npc",
        { id: NPC_ID, personality: "calm, measured", last_seen_turn: 14 },
        makeCtx(fs),
      );
      expect(out).toEqual({ id: NPC_ID, updated: true });
      expect(captured.sets).toHaveLength(1);
      const set = captured.sets[0];
      if (!set) throw new Error("expected one set");
      expect(set.merge).toBe(true);
      const patch = set.data;
      expect(patch.personality).toBe("calm, measured");
      expect(patch.lastSeenTurn).toBe(14);
      expect(patch).toHaveProperty("updatedAt");
      expect(Object.keys(patch).sort()).toEqual(["lastSeenTurn", "personality", "updatedAt"]);
    });

    it("requires id or name (Zod refinement)", async () => {
      const mod = await freshRegistry();
      const fs = makeFakeFirestore(makeCaptured(), {});
      await expect(mod.invokeTool("update_npc", { role: "ally" }, makeCtx(fs))).rejects.toThrow();
    });

    it("throws when no row matched", async () => {
      const mod = await freshRegistry();
      // No NPC seeded — .get() returns exists:false, tool throws.
      const fs = makeFakeFirestore(makeCaptured(), {});
      await expect(
        mod.invokeTool("update_npc", { id: NPC_ID, role: "ally" }, makeCtx(fs)),
      ).rejects.toThrow(/no NPC found/i);
    });
  });

  describe("register_location + register_faction", () => {
    it("register_location inserts with default details + created=true", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {});
      const out = await mod.invokeTool(
        "register_location",
        { name: "The Bebop", first_seen_turn: 1, last_seen_turn: 1 },
        makeCtx(fs),
      );
      expect(out).toMatchObject({ created: true });
      expect((out as { id: string }).id).toMatch(/.+/);
      expect(captured.sets).toHaveLength(1);
      const set = captured.sets[0];
      if (!set) throw new Error("expected one set");
      expect(set.path).toMatch(/\/locations\//);
      expect(set.data.details).toEqual({});
    });

    it("register_faction no-ops on conflict and returns existing id", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {
        subcollectionDocs: {
          factions: [{ id: "red-dragon-syndicate", data: { name: "Red Dragon Syndicate" } }],
        },
      });
      const out = await mod.invokeTool(
        "register_faction",
        { name: "Red Dragon Syndicate" },
        makeCtx(fs),
      );
      expect(out).toEqual({ id: "red-dragon-syndicate", created: false });
      expect(captured.sets).toHaveLength(0);
    });
  });

  describe("record_relationship_event", () => {
    it("appends with npc_id + milestone_type + evidence + turn_number", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      // NPC guard reads npcs/{NPC_ID}.get() — must find the doc.
      const fs = makeFakeFirestore(captured, {
        subcollectionDocs: { npcs: [{ id: NPC_ID, data: { name: "Jet" } }] },
      });
      const out = await mod.invokeTool(
        "record_relationship_event",
        {
          npc_id: NPC_ID,
          milestone_type: "first_vulnerability",
          evidence: "Jet let Spike see the photo of his ex.",
          turn_number: 12,
        },
        makeCtx(fs),
      );
      expect((out as { id: string }).id).toMatch(/.+/);
      expect(captured.adds).toHaveLength(1);
      const add = captured.adds[0];
      if (!add) throw new Error("expected one add");
      expect(add.path).toMatch(/\/relationshipEvents$/);
      const v = add.data;
      expect(v.campaignId).toBe(CAMPAIGN);
      expect(v.npcId).toBe(NPC_ID);
      expect(v.milestoneType).toBe("first_vulnerability");
      expect(v.turnNumber).toBe(12);
    });

    it("rejects empty milestone_type", async () => {
      const mod = await freshRegistry();
      const fs = makeFakeFirestore(makeCaptured(), {});
      await expect(
        mod.invokeTool(
          "record_relationship_event",
          { npc_id: NPC_ID, milestone_type: "", evidence: "x", turn_number: 1 },
          makeCtx(fs),
        ),
      ).rejects.toThrow();
    });

    it("cross-campaign FK guard: rejects npc_id that belongs to another campaign", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      // No npc seeded → guard's .get() returns exists:false → throw.
      const fs = makeFakeFirestore(captured, {});
      await expect(
        mod.invokeTool(
          "record_relationship_event",
          {
            npc_id: NPC_ID,
            milestone_type: "first_trust",
            evidence: "x",
            turn_number: 1,
          },
          makeCtx(fs),
        ),
      ).rejects.toThrow(/not found in this campaign/i);
      expect(captured.adds).toHaveLength(0);
    });
  });

  describe("write_semantic_memory", () => {
    it("inserts with default heat 100 (Phase 4 v3-parity: start hot, let decay do the work)", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {});
      await mod.invokeTool(
        "write_semantic_memory",
        { category: "relationship", content: "Spike owes Jet gas money.", turn_number: 8 },
        makeCtx(fs),
      );
      expect(captured.adds).toHaveLength(1);
      const add = captured.adds[0];
      if (!add) throw new Error("expected one add");
      const v = add.data;
      expect(v.heat).toBe(100);
      expect(v.embedding).toBeNull(); // explicit null in the write
      expect(v.flags).toEqual({}); // default empty when not provided
    });

    it("persists flags (plot_critical bypasses decay)", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {});
      await mod.invokeTool(
        "write_semantic_memory",
        {
          category: "lore",
          content: "The Red Dragon syndicate funds Vicious.",
          turn_number: 1,
          flags: { plot_critical: true },
        },
        makeCtx(fs),
      );
      const add = captured.adds[0];
      if (!add) throw new Error("expected one add");
      expect(add.data.flags).toEqual({ plot_critical: true });
    });

    it("clamps heat to [0, 100]", async () => {
      const mod = await freshRegistry();
      const fs = makeFakeFirestore(makeCaptured(), {});
      await expect(
        mod.invokeTool(
          "write_semantic_memory",
          { category: "x", content: "x", heat: 150, turn_number: 1 },
          makeCtx(fs),
        ),
      ).rejects.toThrow();
    });
  });

  describe("write_episodic_summary", () => {
    it("updates turns.summary by campaign + turn_number", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      // Seed a turn doc whose where(turnNumber == 5) query will resolve.
      const fs = makeFakeFirestore(captured, {
        subcollectionDocs: { turns: [{ id: "turn-5", data: { turnNumber: 5 } }] },
      });
      const out = await mod.invokeTool(
        "write_episodic_summary",
        { turn_number: 5, summary: "Jet told the story of his ex-partner." },
        makeCtx(fs),
      );
      expect(out).toEqual({ turn_number: 5, updated: true });
      expect(captured.sets).toHaveLength(1);
      const set = captured.sets[0];
      if (!set) throw new Error("expected one set");
      expect(set.merge).toBe(true);
      expect(set.data.summary).toBe("Jet told the story of his ex-partner.");
    });

    it("throws when the turn row does not exist", async () => {
      const mod = await freshRegistry();
      // No turn seeded → query returns empty → tool throws.
      const fs = makeFakeFirestore(makeCaptured(), {});
      await expect(
        mod.invokeTool("write_episodic_summary", { turn_number: 99, summary: "x" }, makeCtx(fs)),
      ).rejects.toThrow(/no turn row/i);
    });
  });

  describe("plant_foreshadowing_candidate", () => {
    it("inserts with status PLANTED and returns id + literal status", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {});
      const out = await mod.invokeTool(
        "plant_foreshadowing_candidate",
        {
          name: "Faye's mystery tape",
          description: "A Beta tape she hasn't watched.",
          payoff_window_min: 5,
          payoff_window_max: 20,
          planted_turn: 2,
        },
        makeCtx(fs),
      );
      expect(out).toMatchObject({ status: "PLANTED" });
      expect((out as { id: string }).id).toMatch(/.+/);
      expect(captured.adds).toHaveLength(1);
      const add = captured.adds[0];
      if (!add) throw new Error("expected one add");
      expect(add.path).toMatch(/\/foreshadowingSeeds$/);
      const v = add.data;
      expect(v.status).toBe("PLANTED");
      expect(v.dependsOn).toEqual([]);
      expect(v.conflictsWith).toEqual([]);
    });
  });

  describe("plant_foreshadowing_seed (KA path, upgraded from stub)", () => {
    it("inserts real row and returns seed_id + status PLANTED", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {});
      const out = await mod.invokeTool(
        "plant_foreshadowing_seed",
        {
          name: "Vicious's call",
          description: "A phone call Spike didn't pick up.",
          payoff_window_min: 3,
          payoff_window_max: 10,
          planted_turn: 4,
        },
        makeCtx(fs),
      );
      expect(out).toMatchObject({ status: "PLANTED" });
      expect((out as { seed_id: string }).seed_id).toMatch(/.+/);
      expect(captured.adds).toHaveLength(1);
      const add = captured.adds[0];
      if (!add) throw new Error("expected one add");
      expect(add.path).toMatch(/\/foreshadowingSeeds$/);
    });
  });

  describe("update_arc_plan", () => {
    it("appends arc-plan snapshot with tension formatted to 2dp", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {});
      const out = await mod.invokeTool(
        "update_arc_plan",
        {
          current_arc: "Syndicate closing in",
          arc_phase: "complication",
          arc_mode: "main_arc",
          planned_beats: ["Faye picks up a lead", "Jet warns Spike"],
          tension_level: 0.75,
          set_at_turn: 15,
        },
        makeCtx(fs),
      );
      expect(out).toMatchObject({ set_at_turn: 15 });
      expect((out as { id: string }).id).toMatch(/.+/);
      expect(captured.adds).toHaveLength(1);
      const add = captured.adds[0];
      if (!add) throw new Error("expected one add");
      // Firestore stores numbers natively now; 2dp rounded numerically.
      expect(add.data.tensionLevel).toBe(0.75);
      expect(add.data.plannedBeats).toEqual(["Faye picks up a lead", "Jet warns Spike"]);
    });

    it("rejects invalid arc_phase", async () => {
      const mod = await freshRegistry();
      const fs = makeFakeFirestore(makeCaptured(), {});
      await expect(
        mod.invokeTool(
          "update_arc_plan",
          {
            current_arc: "x",
            arc_phase: "nonsense",
            arc_mode: "main_arc",
            tension_level: 0.5,
            set_at_turn: 1,
          },
          makeCtx(fs),
        ),
      ).rejects.toThrow();
    });
  });

  describe("update_voice_patterns", () => {
    it("appends a pattern row", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {});
      const out = await mod.invokeTool(
        "update_voice_patterns",
        { pattern: "terse openings land well", turn_observed: 5 },
        makeCtx(fs),
      );
      expect((out as { id: string }).id).toMatch(/.+/);
      expect(captured.adds).toHaveLength(1);
      const add = captured.adds[0];
      if (!add) throw new Error("expected one add");
      expect(add.data.pattern).toBe("terse openings land well");
      expect(add.data.evidence).toBe(""); // default
    });
  });

  describe("write_director_note", () => {
    it("defaults scope to session", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {});
      await mod.invokeTool(
        "write_director_note",
        { content: "Keep Faye in the frame.", created_at_turn: 3 },
        makeCtx(fs),
      );
      const add = captured.adds[0];
      if (!add) throw new Error("expected one add");
      expect(add.data.scope).toBe("session");
    });

    it("rejects invalid scope", async () => {
      const mod = await freshRegistry();
      const fs = makeFakeFirestore(makeCaptured(), {});
      await expect(
        mod.invokeTool(
          "write_director_note",
          { content: "x", scope: "bogus", created_at_turn: 1 },
          makeCtx(fs),
        ),
      ).rejects.toThrow();
    });
  });

  describe("adjust_spotlight_debt", () => {
    it("upserts on (campaign, npc) with FieldValue.increment delta", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      // NPC guard must find the NPC; spotlightDebt seeded with debt=-3 so the
      // tool's read-after-write returns -3 (matches the test's expected value).
      const fs = makeFakeFirestore(captured, {
        subcollectionDocs: {
          npcs: [{ id: NPC_ID, data: { name: "Jet" } }],
          spotlightDebt: [{ id: NPC_ID, data: { debt: -3 } }],
        },
      });
      const out = await mod.invokeTool(
        "adjust_spotlight_debt",
        { npc_id: NPC_ID, delta: -1, updated_at_turn: 10 },
        makeCtx(fs),
      );
      expect(out).toEqual({ npc_id: NPC_ID, debt: -3 });
      expect(captured.sets).toHaveLength(1);
      const set = captured.sets[0];
      if (!set) throw new Error("expected one set");
      expect(set.merge).toBe(true);
      expect(set.path).toMatch(/\/spotlightDebt\//);
      // The increment sentinel travels through as a FieldValue object.
      expect(set.data.npcId).toBe(NPC_ID);
      expect(set.data.updatedAtTurn).toBe(10);
      expect(set.data).toHaveProperty("debt");
    });

    it("cross-campaign FK guard: rejects npc_id from another campaign", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      // No npcs seeded → guard's .get() returns exists:false → throw.
      const fs = makeFakeFirestore(captured, {});
      await expect(
        mod.invokeTool(
          "adjust_spotlight_debt",
          { npc_id: NPC_ID, delta: 1, updated_at_turn: 5 },
          makeCtx(fs),
        ),
      ).rejects.toThrow(/not found in this campaign/i);
      expect(captured.sets).toHaveLength(0);
    });
  });

  describe("ratify_foreshadowing_seed", () => {
    it("transitions PLANTED → GROWING and returns status GROWING", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {
        subcollectionDocs: {
          foreshadowingSeeds: [{ id: UUID, data: { status: "PLANTED" } }],
        },
      });
      const out = await mod.invokeTool(
        "ratify_foreshadowing_seed",
        { seed_id: UUID },
        makeCtx(fs),
      );
      expect(out).toEqual({ seed_id: UUID, status: "GROWING" });
      expect(captured.sets).toHaveLength(1);
      const set = captured.sets[0];
      if (!set) throw new Error("expected one set");
      expect(set.merge).toBe(true);
      expect(set.data.status).toBe("GROWING");
      expect(set.data).toHaveProperty("updatedAt");
    });

    it("throws when seed isn't in PLANTED state (no row matched)", async () => {
      const mod = await freshRegistry();
      // Seed exists but isn't PLANTED → the status guard throws.
      const fs = makeFakeFirestore(makeCaptured(), {
        subcollectionDocs: {
          foreshadowingSeeds: [{ id: UUID, data: { status: "GROWING" } }],
        },
      });
      await expect(
        mod.invokeTool("ratify_foreshadowing_seed", { seed_id: UUID }, makeCtx(fs)),
      ).rejects.toThrow(/no PLANTED seed/i);
    });
  });

  describe("retire_foreshadowing_seed", () => {
    it("transitions active seed → ABANDONED", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {
        subcollectionDocs: {
          foreshadowingSeeds: [{ id: UUID, data: { status: "GROWING" } }],
        },
      });
      const out = await mod.invokeTool(
        "retire_foreshadowing_seed",
        { seed_id: UUID, reason: "Plot moved past it" },
        makeCtx(fs),
      );
      expect(out).toEqual({ seed_id: UUID, status: "ABANDONED" });
      const set = captured.sets[0];
      if (!set) throw new Error("expected one set");
      expect(set.data.status).toBe("ABANDONED");
    });

    it("throws when seed is already terminal (no active row matched)", async () => {
      const mod = await freshRegistry();
      // Seed exists but is RESOLVED (terminal) → tool throws.
      const fs = makeFakeFirestore(makeCaptured(), {
        subcollectionDocs: {
          foreshadowingSeeds: [{ id: UUID, data: { status: "RESOLVED" } }],
        },
      });
      await expect(
        mod.invokeTool("retire_foreshadowing_seed", { seed_id: UUID }, makeCtx(fs)),
      ).rejects.toThrow(/no active seed/i);
    });
  });

  describe("trigger_compactor", () => {
    it("returns turn_count + should_compact=false + empty oldest when below threshold", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, {
        subcollectionDocs: {
          turns: [
            { id: "t-1", data: { turnNumber: 1, narrativeText: "scene 1", summary: "s1" } },
            { id: "t-2", data: { turnNumber: 2, narrativeText: "scene 2", summary: null } },
            { id: "t-3", data: { turnNumber: 3, narrativeText: "scene 3", summary: null } },
          ],
        },
      });
      const out = await mod.invokeTool("trigger_compactor", {}, makeCtx(fs));
      expect(out).toMatchObject({
        turn_count: 3,
        threshold: 20,
        should_compact: false,
        oldest_turns: [],
      });
    });

    it("returns oldest N turn narratives when above threshold", async () => {
      const mod = await freshRegistry();
      const turns = Array.from({ length: 25 }, (_, i) => ({
        id: `t-${i + 1}`,
        data: {
          turnNumber: i + 1,
          narrativeText: `scene ${i + 1}`,
          summary: i % 2 === 0 ? `s${i + 1}` : null,
        },
      }));
      const captured = makeCaptured();
      const fs = makeFakeFirestore(captured, { subcollectionDocs: { turns } });
      const out = (await mod.invokeTool(
        "trigger_compactor",
        { threshold: 20, compact_count: 5 },
        makeCtx(fs),
      )) as { should_compact: boolean; oldest_turns: Array<{ turn_number: number }> };
      expect(out.should_compact).toBe(true);
      // The fake doesn't slice/order the docs, so it returns the seeded
      // order — turns 1..25 → first 5 are 1..5. Matches the test's intent.
      expect(out.oldest_turns.map((t) => t.turn_number)).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
