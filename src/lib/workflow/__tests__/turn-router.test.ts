import type { IntentOutput } from "@/lib/types/turn";
import type { Firestore } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * turn-router.test.ts — short-circuit persistence (Phase 1, v3-audit
 * closure). Validates the bind-state paths the original implementation
 * was missing:
 *
 *   - /override → campaign.settings.overrides append
 *   - WB-ACCEPT entityUpdates → Chronicler write tools invoked
 *
 * These tests drive runTurn with a stubbed routePlayerMessage (via the
 * `routeFn` dep) so we don't have to mock three sub-agents + two
 * structured-runner providers to get a deterministic verdict shape.
 *
 * `invokeTool` is mocked at the module level so WB-ACCEPT tests can
 * assert which tools fired + with what inputs, without requiring real
 * Firestore round-trips through the tool registry.
 */

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "user-1";
const PROFILE_SLUG = "cowboy-bebop";

// ---------------------------------------------------------------------------
// Module-level mock for invokeTool — must appear before the import below.
// ---------------------------------------------------------------------------
vi.mock("@/lib/tools", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tools")>("@/lib/tools");
  return {
    ...actual,
    invokeTool: vi.fn(async () => ({ id: "fake-id", created: true })),
  };
});

// Profile fixture that satisfies Profile.parse with minimal shape.
const MIN_PROFILE = {
  id: "cowboy-bebop",
  title: "Cowboy Bebop",
  alternate_titles: [],
  media_type: "anime",
  status: "completed",
  relation_type: "canonical",
  ip_mechanics: {
    power_distribution: {
      peak_tier: "T7",
      typical_tier: "T9",
      floor_tier: "T10",
      gradient: "flat",
    },
    stat_mapping: {
      has_canonical_stats: false,
      confidence: 50,
      aliases: {},
      meta_resources: {},
      hidden: [],
      display_order: [],
    },
    combat_style: "tactical",
    storytelling_tropes: {
      tournament_arc: false,
      training_montage: false,
      power_of_friendship: false,
      mentor_death: false,
      chosen_one: false,
      tragic_backstory: false,
      redemption_arc: false,
      betrayal: false,
      sacrifice: false,
      transformation: false,
      forbidden_technique: false,
      time_loop: false,
      false_identity: false,
      ensemble_focus: true,
      slow_burn_romance: false,
    },
    world_setting: { genre: ["noir"], locations: [], factions: [], time_period: "2071" },
    voice_cards: [],
    author_voice: {
      sentence_patterns: [],
      structural_motifs: [],
      dialogue_quirks: [],
      emotional_rhythm: [],
      example_voice: "",
    },
    visual_style: { art_style: "", color_palette: "", reference_descriptors: [] },
  },
  canonical_dna: {
    pacing: 6,
    continuity: 3,
    density: 4,
    temporal_structure: 4,
    optimism: 3,
    darkness: 7,
    comedy: 4,
    emotional_register: 6,
    intimacy: 6,
    fidelity: 7,
    reflexivity: 3,
    avant_garde: 6,
    epistemics: 6,
    moral_complexity: 8,
    didacticism: 3,
    cruelty: 5,
    power_treatment: 6,
    scope: 5,
    agency: 6,
    interiority: 6,
    conflict_style: 5,
    register: 7,
    empathy: 8,
    accessibility: 7,
  },
  canonical_composition: {
    tension_source: "existential",
    power_expression: "flashy",
    narrative_focus: "ensemble",
    mode: "standard",
    antagonist_origin: "interpersonal",
    antagonist_multiplicity: "episodic",
    arc_shape: "fragmented",
    resolution_trajectory: "ambiguous",
    escalation_pattern: "waves",
    status_quo_stability: "gradual",
    player_role: "protagonist",
    choice_weight: "local",
    story_time_density: "months",
  },
  director_personality: "noir-inflected, restrained, melancholic",
};

// ---------------------------------------------------------------------------
// Fake Firestore with write tracking. Maintains a campaign settings
// reference so writes visibly mutate the next read (used by the
// "next turn reads back override" test).
// ---------------------------------------------------------------------------

interface FsTrace {
  /** Captured `add` payloads on the turns subcollection. */
  turnAdds: Array<Record<string, unknown>>;
  /** Captured `set` payloads on the campaign doc (settings + locks). */
  campaignSets: Array<Record<string, unknown>>;
}

interface FsState {
  /** Mutable settings — writes that include `settings` mutate this so
   * subsequent reads in the same test see the persisted state. */
  campaignSettings: Record<string, unknown>;
}

function fakeFirestore(trace: FsTrace, state: FsState): Firestore {
  const turnsCol = {
    add: async (data: Record<string, unknown>) => {
      trace.turnAdds.push(data);
      return { id: "turn-row-id" };
    },
    orderBy: () => ({
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
    }),
    where: () => ({
      orderBy: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
    }),
  };
  const charactersCol = {
    limit: () => ({
      get: async () => ({
        empty: false,
        docs: [
          {
            id: "c1",
            data: () => ({
              campaignId: CAMPAIGN_ID,
              name: "Spike",
              concept: "ex-syndicate bounty hunter",
              powerTier: "T7",
              sheet: {},
              createdAt: new Date(),
            }),
          },
        ],
      }),
    }),
  };
  // Chainable empty-query stub — every method returns the same object,
  // every `.get()` resolves to an empty snap. Removes need to handcraft
  // each query shape (where→orderBy→limit, limit→get, etc.).
  const emptySnap = async () => ({ empty: true, docs: [] });
  const emptyQuery: Record<string, unknown> = {};
  emptyQuery.where = () => emptyQuery;
  emptyQuery.orderBy = () => emptyQuery;
  emptyQuery.limit = () => emptyQuery;
  emptyQuery.get = emptySnap;
  const npcsCol = emptyQuery;
  const subcolEmpty = emptyQuery;

  const campaignDocRef = {
    get: async () => ({
      exists: true,
      data: () => ({
        ownerUid: USER_ID,
        deletedAt: null,
        name: "Test Campaign",
        phase: "playing",
        profileRefs: [PROFILE_SLUG],
        settings: state.campaignSettings,
      }),
    }),
    set: async (data: Record<string, unknown>, _opts?: { merge?: boolean }) => {
      trace.campaignSets.push(data);
      // Persist settings so subsequent reads see the mutation.
      const incoming = data.settings;
      if (incoming && typeof incoming === "object") {
        state.campaignSettings = incoming as Record<string, unknown>;
      }
    },
    collection: (name: string) => {
      if (name === "turns") return turnsCol;
      if (name === "characters") return charactersCol;
      if (name === "npcs") return npcsCol;
      return subcolEmpty;
    },
  };

  const profilesCol = {
    where: () => ({
      limit: () => ({
        get: async () => ({
          empty: false,
          docs: [
            {
              id: "p1",
              data: () => ({
                slug: PROFILE_SLUG,
                title: "Cowboy Bebop",
                mediaType: "anime",
                content: MIN_PROFILE,
                version: 1,
                createdAt: new Date(),
              }),
            },
          ],
        }),
      }),
    }),
  };

  return {
    collection: (name: string) => {
      if (name === "campaigns") return { doc: () => campaignDocRef };
      if (name === "profiles") return profilesCol;
      if (name === "ruleLibraryChunks") return emptyQuery;
      throw new Error(`unexpected collection ${name}`);
    },
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const tx = {
        get: async (ref: unknown) => {
          if (ref === campaignDocRef) return campaignDocRef.get();
          throw new Error("unexpected tx.get");
        },
        set: (ref: unknown, data: Record<string, unknown>) => {
          if (ref === campaignDocRef) {
            trace.campaignSets.push(data);
          }
        },
      };
      return fn(tx);
    },
  } as unknown as Firestore;
}

function makeTrace(): FsTrace {
  return { turnAdds: [], campaignSets: [] };
}

function makeIntent(overrides: Partial<IntentOutput> = {}): IntentOutput {
  return {
    intent: "DEFAULT",
    action: "ack",
    epicness: 0.2,
    special_conditions: [],
    confidence: 0.9,
    ...overrides,
  };
}

describe("runTurn — /override persistence (Phase 1, v3-audit closure)", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("appends a new override entry to campaign.settings.overrides on ACK", async () => {
    const trace = makeTrace();
    const state: FsState = { campaignSettings: { overrides: [] } };
    const firestore = fakeFirestore(trace, state);
    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "override" as const,
      intent: makeIntent({ intent: "OVERRIDE_COMMAND" }),
      override: {
        mode: "override" as const,
        category: "NPC_PROTECTION" as const,
        value: "Jet cannot die",
        scope: "campaign" as const,
        conflicts_with: [],
        ack_phrasing: "Noted. Jet is protected.",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "/override Jet cannot die" },
      { firestore, routeFn },
    );
    const events: string[] = [];
    for await (const ev of iter) {
      events.push(ev.type);
    }
    expect(events).toContain("routed");
    expect(events).toContain("done");

    // campaign settings update fired with the new override appended.
    const settingsUpdates = trace.campaignSets.filter(
      (p) => Object.hasOwn(p, "settings") && !Object.hasOwn(p, "turnInFlight"),
    );
    expect(settingsUpdates).toHaveLength(1);
    const patch = settingsUpdates[0] as { settings: { overrides: unknown[] } };
    expect(patch.settings.overrides).toHaveLength(1);
    const [newOverride] = patch.settings.overrides as Array<{
      id: string;
      category: string;
      value: string;
      scope: string;
      created_at: string;
    }>;
    expect(newOverride?.category).toBe("NPC_PROTECTION");
    expect(newOverride?.value).toBe("Jet cannot die");
    expect(newOverride?.scope).toBe("campaign");
    expect(newOverride?.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("preserves existing overrides and appends new (not clobber)", async () => {
    const trace = makeTrace();
    const existingOverride = {
      id: "pre-existing",
      category: "TONE_REQUIREMENT",
      value: "No swearing",
      scope: "campaign",
      created_at: "2026-04-20T00:00:00Z",
    };
    const state: FsState = { campaignSettings: { overrides: [existingOverride] } };
    const firestore = fakeFirestore(trace, state);

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "override" as const,
      intent: makeIntent({ intent: "OVERRIDE_COMMAND" }),
      override: {
        mode: "override" as const,
        category: "NARRATIVE_DEMAND" as const,
        value: "No combat this session",
        scope: "session" as const,
        conflicts_with: [],
        ack_phrasing: "Heard.",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      {
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        playerMessage: "/override No combat this session",
      },
      { firestore, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }

    const settingsUpdates = trace.campaignSets.filter(
      (p) => Object.hasOwn(p, "settings") && !Object.hasOwn(p, "turnInFlight"),
    );
    expect(settingsUpdates).toHaveLength(1);
    const patch = settingsUpdates[0] as { settings: { overrides: unknown[] } };
    expect(patch.settings.overrides).toHaveLength(2);
    const ids = (patch.settings.overrides as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain("pre-existing");
  });

  it("next turn's router reads the persisted override back via priorOverrides (v3-parity plan §1.1)", async () => {
    const trace = makeTrace();
    const state: FsState = { campaignSettings: { overrides: [] } };
    const firestore = fakeFirestore(trace, state);
    const { runTurn } = await import("../turn");

    const firstRouteFn = (async () => ({
      kind: "override" as const,
      intent: makeIntent({ intent: "OVERRIDE_COMMAND" }),
      override: {
        mode: "override" as const,
        category: "CONTENT_CONSTRAINT" as const,
        value: "No explicit violence",
        scope: "campaign" as const,
        conflicts_with: [],
        ack_phrasing: "Noted.",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "/override no violence" },
      { firestore, routeFn: firstRouteFn },
    )) {
      /* drain */
    }

    // Second turn: router receives priorOverrides populated from first persist.
    let capturedPriorOverrides: unknown[] | undefined;
    const secondRouteFn = (async (input: { priorOverrides?: unknown[] }) => {
      capturedPriorOverrides = input.priorOverrides;
      return {
        kind: "continue" as const,
        intent: makeIntent({ intent: "DEFAULT", epicness: 0.05 }),
      };
    }) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    // Mock runKa to avoid reaching the real Agent SDK.
    const mockRunKa = async function* () {
      yield {
        kind: "final",
        narrative: "nothing happens.",
        ttftMs: null,
        totalMs: 10,
        costUsd: 0,
        sessionId: null,
        stopReason: "end_turn",
      };
    } as unknown as Parameters<typeof runTurn>[1]["runKa"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "continue" },
      { firestore, routeFn: secondRouteFn, runKa: mockRunKa },
    )) {
      /* drain */
    }

    expect(capturedPriorOverrides).toBeDefined();
    expect(capturedPriorOverrides).toHaveLength(1);
    const [o] = capturedPriorOverrides as Array<{ category: string; value: string; scope: string }>;
    expect(o?.category).toBe("CONTENT_CONSTRAINT");
    expect(o?.value).toBe("No explicit violence");
    expect(o?.scope).toBe("campaign");
  });

  it("does not persist when override mode is 'meta' (meta conversation Phase 5)", async () => {
    const trace = makeTrace();
    const state: FsState = { campaignSettings: {} };
    const firestore = fakeFirestore(trace, state);
    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "meta" as const,
      intent: makeIntent({ intent: "META_FEEDBACK" }),
      override: {
        mode: "meta" as const,
        category: null,
        value: "I'd like less swearing going forward",
        scope: "campaign" as const,
        conflicts_with: [],
        ack_phrasing: "Heard.",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "/meta less swearing" },
      { firestore, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }
    // No settings update for meta-mode overrides at Phase 1.
    const settingsUpdates = trace.campaignSets.filter(
      (p) => Object.hasOwn(p, "settings") && !Object.hasOwn(p, "turnInFlight"),
    );
    expect(settingsUpdates).toHaveLength(0);
  });
});

describe("runTurn — WB ACCEPT entity persistence (WB reshape: continues through KA)", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  // Shared mockRunKa — WB reshape moved ACCEPT/FLAG onto the continue
  // path, so KA runs on these turns. Stub a minimal final event so the
  // workflow completes and entity persistence can be asserted.
  const makeMockRunKa = () =>
    async function* () {
      yield {
        kind: "final",
        narrative: "KA narrated with the assertion as canon.",
        ttftMs: null,
        totalMs: 1,
        costUsd: 0,
        sessionId: null,
        stopReason: "end_turn",
      };
    } as unknown as Parameters<typeof import("../turn").runTurn>[1]["runKa"];

  it("invokes register_npc for npc entityUpdates (now on continue path)", async () => {
    const trace = makeTrace();
    const state: FsState = { campaignSettings: {} };
    const firestore = fakeFirestore(trace, state);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "continue" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      wbAssertion: {
        assertion: "Jet is a retired ISSP major",
        decision: "ACCEPT" as const,
        acknowledgment: "Of course — Jet's ISSP past is canon.",
        entityUpdates: [
          {
            kind: "npc" as const,
            name: "Jet Black",
            details: "Former ISSP major; Bebop co-captain",
          },
        ],
        flags: [],
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      {
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        playerMessage: "Jet is a retired ISSP major",
      },
      { firestore, routeFn, runKa: makeMockRunKa() },
    );
    for await (const _ of iter) {
      /* drain */
    }

    expect(invokeSpy).toHaveBeenCalledWith(
      "register_npc",
      expect.objectContaining({
        name: "Jet Black",
        personality: "Former ISSP major; Bebop co-captain",
      }),
      expect.objectContaining({ campaignId: CAMPAIGN_ID, userId: USER_ID }),
    );
  });

  it("invokes register_location for location entityUpdates", async () => {
    const trace = makeTrace();
    const state: FsState = { campaignSettings: {} };
    const firestore = fakeFirestore(trace, state);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "continue" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      wbAssertion: {
        assertion: "I dock at Tharsis 17",
        decision: "ACCEPT" as const,
        acknowledgment: "The docking bay is yours.",
        entityUpdates: [
          {
            kind: "location" as const,
            name: "Tharsis Dock 17",
            details: "grimy orbital dock; Red Dragon territory",
          },
        ],
        flags: [],
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      {
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        playerMessage: "I dock at Tharsis 17",
      },
      { firestore, routeFn, runKa: makeMockRunKa() },
    );
    for await (const _ of iter) {
      /* drain */
    }

    expect(invokeSpy).toHaveBeenCalledWith(
      "register_location",
      expect.objectContaining({
        name: "Tharsis Dock 17",
        details: { description: "grimy orbital dock; Red Dragon territory" },
      }),
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
  });

  it("invokes write_semantic_memory with heat 80 for player-asserted facts", async () => {
    const trace = makeTrace();
    const state: FsState = { campaignSettings: {} };
    const firestore = fakeFirestore(trace, state);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "continue" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      wbAssertion: {
        assertion: "Spike owes Vicious money",
        decision: "ACCEPT" as const,
        acknowledgment: "Established.",
        entityUpdates: [
          {
            kind: "fact" as const,
            name: "Red Dragon debt",
            details: "Spike owes Vicious twelve million woolongs",
          },
        ],
        flags: [],
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      {
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        playerMessage: "Spike owes Vicious money",
      },
      { firestore, routeFn, runKa: makeMockRunKa() },
    );
    for await (const _ of iter) {
      /* drain */
    }

    expect(invokeSpy).toHaveBeenCalledWith(
      "write_semantic_memory",
      expect.objectContaining({
        category: "fact",
        heat: 80,
        content: expect.stringContaining("Red Dragon debt"),
      }),
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
  });

  it("does NOT invoke any tools on WB CLARIFY (short-circuits, no KA, no persistence)", async () => {
    const trace = makeTrace();
    const state: FsState = { campaignSettings: {} };
    const firestore = fakeFirestore(trace, state);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();

    const { runTurn } = await import("../turn");

    // CLARIFY stays on the worldbuilder verdict kind — short-circuits.
    const routeFn = (async () => ({
      kind: "worldbuilder" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      verdict: {
        decision: "CLARIFY" as const,
        response: "Tell me more about the amulet.",
        entityUpdates: [{ kind: "npc" as const, name: "x", details: "y" }],
        flags: [],
        rationale: "needs clarification",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "I pull out my amulet" },
      { firestore, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }

    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("continues processing remaining updates when one fails", async () => {
    const trace = makeTrace();
    const state: FsState = { campaignSettings: {} };
    const firestore = fakeFirestore(trace, state);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();
    // First call fails, rest succeed.
    invokeSpy.mockImplementationOnce(async () => {
      throw new Error("simulated failure");
    });
    invokeSpy.mockImplementation(async () => ({ id: "fake", created: true }));

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "continue" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      wbAssertion: {
        assertion: "assert much",
        decision: "ACCEPT" as const,
        acknowledgment: "noted.",
        entityUpdates: [
          { kind: "npc" as const, name: "A", details: "a" },
          { kind: "location" as const, name: "B", details: "b" },
          { kind: "fact" as const, name: "C", details: "c" },
        ],
        flags: [],
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "assert much" },
      { firestore, routeFn, runKa: makeMockRunKa() },
    );
    for await (const _ of iter) {
      /* drain */
    }

    // All three were attempted despite first throwing.
    expect(invokeSpy).toHaveBeenCalledTimes(3);
  });

  it("emits WB flags on the done event (WB reshape)", async () => {
    const trace = makeTrace();
    const state: FsState = { campaignSettings: {} };
    const firestore = fakeFirestore(trace, state);
    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "continue" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      wbAssertion: {
        assertion: "galactic empire spanning ten thousand years",
        decision: "FLAG" as const,
        acknowledgment: "Noted.",
        entityUpdates: [],
        flags: [
          {
            kind: "voice_fit" as const,
            evidence: "galactic-empire scale in a grounded noir",
            suggestion: "consider implying the scope off-screen",
          },
        ],
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "galactic empire…" },
      { firestore, routeFn, runKa: makeMockRunKa() },
    );
    const events: Array<{ type: string; flags?: unknown[] }> = [];
    for await (const ev of iter) events.push(ev as { type: string; flags?: unknown[] });

    const done = events.find((e) => e.type === "done") as
      | { type: "done"; flags: Array<{ kind: string }> }
      | undefined;
    expect(done).toBeDefined();
    expect(done?.flags).toHaveLength(1);
    expect(done?.flags[0]?.kind).toBe("voice_fit");
  });
});
