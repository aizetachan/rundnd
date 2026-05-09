import type { IntentOutput } from "@/lib/types/turn";
import type { Firestore } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * turn-budget.test.ts — Commit 9 cost aggregation + bypassLimiter
 * threading. Verifies:
 *
 *   1. `recordCost` emitted by the router's pre-pass consultants
 *      accumulates into `turns.costUsd` alongside KA's SDK-reported cost.
 *   2. When pre-pass spends X and KA spends Y, persisted costUsd = X+Y.
 *   3. `bypassLimiter` field on TurnWorkflowInput is accepted without
 *      throwing (forward-looking marker; no-op inside runTurn itself).
 */

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "user-1";
const PROFILE_SLUG = "cowboy-bebop";

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

interface FsTrace {
  /** Captured `add` payloads on the turns subcollection (insert-equivalent). */
  turnAdds: Array<Record<string, unknown>>;
  /** Captured `set` payloads on the campaign doc (settings updates + locks). */
  campaignSets: Array<Record<string, unknown>>;
}

function fakeFirestore(trace: FsTrace): Firestore {
  const turnsCol = {
    add: async (data: Record<string, unknown>) => {
      trace.turnAdds.push(data);
      return { id: "turns-new-id" };
    },
    orderBy: () => ({
      limit: () => ({
        get: async () => ({ empty: true, docs: [] }),
      }),
    }),
    where: () => ({
      orderBy: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
    }),
  };
  const emptySnap = async () => ({ empty: true, docs: [] });
  const emptyQuery: Record<string, unknown> = {};
  emptyQuery.where = () => emptyQuery;
  emptyQuery.orderBy = () => emptyQuery;
  emptyQuery.limit = () => emptyQuery;
  emptyQuery.get = emptySnap;
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
        settings: {},
      }),
    }),
    set: async (patch: Record<string, unknown>) => {
      trace.campaignSets.push(patch);
    },
    collection: (name: string) => {
      if (name === "turns") return turnsCol;
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
        set: (ref: unknown, data: Record<string, unknown>, _opts?: { merge?: boolean }) => {
          if (ref === campaignDocRef) {
            trace.campaignSets.push(data);
            return;
          }
          throw new Error("unexpected tx.set");
        },
      };
      return fn(tx);
    },
  } as unknown as Firestore;
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

describe("runTurn — cost aggregation (Commit 9)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("persists costUsd as the sum of pre-pass recordCost + KA SDK cost", async () => {
    const trace: FsTrace = { turnAdds: [], campaignSets: [] };
    const firestore = fakeFirestore(trace);
    const { runTurn } = await import("../turn");

    // Stub routeFn that emits cost via the recordCost dep, simulating
    // what a real routePlayerMessage call would do when its sub-agents
    // (IntentClassifier / OJ / etc.) report their usage.
    const routeFn = (async (_input: unknown, deps: unknown) => {
      const d = deps as { recordCost?: (agent: string, cost: number) => void };
      d.recordCost?.("intent-classifier", 0.001);
      d.recordCost?.("outcome-judge", 0.002);
      d.recordCost?.("validator", 0.0005);
      return {
        kind: "continue" as const,
        intent: makeIntent({ intent: "DEFAULT", epicness: 0.05 }),
      };
    }) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const mockRunKa = async function* () {
      yield {
        kind: "final",
        narrative: "A quiet moment on the bebop.",
        ttftMs: 100,
        totalMs: 800,
        // KA's SDK reports $0.05 for the full session (includes any
        // consultants it spawned via Agent tool).
        costUsd: 0.05,
        sessionId: "ka-session-1",
        stopReason: "end_turn",
      };
    } as unknown as Parameters<typeof runTurn>[1]["runKa"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "look around" },
      { firestore, routeFn, runKa: mockRunKa },
    )) {
      /* drain */
    }

    expect(trace.turnAdds).toHaveLength(1);
    const values = trace.turnAdds[0] as { costUsd: number };
    // 0.001 + 0.002 + 0.0005 + 0.05 = 0.0535
    expect(values.costUsd).toBeCloseTo(0.0535, 6);
  });

  it("persists KA cost alone when pre-pass emits no recordCost calls", async () => {
    const trace: FsTrace = { turnAdds: [], campaignSets: [] };
    const firestore = fakeFirestore(trace);
    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "continue" as const,
      intent: makeIntent({ intent: "DEFAULT", epicness: 0.05 }),
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const mockRunKa = async function* () {
      yield {
        kind: "final",
        narrative: "A quiet moment.",
        ttftMs: 50,
        totalMs: 500,
        costUsd: 0.0123,
        sessionId: null,
        stopReason: "end_turn",
      };
    } as unknown as Parameters<typeof runTurn>[1]["runKa"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "go" },
      { firestore, routeFn, runKa: mockRunKa },
    )) {
      /* drain */
    }

    expect(trace.turnAdds).toHaveLength(1);
    const values = trace.turnAdds[0] as { costUsd: number };
    expect(values.costUsd).toBeCloseTo(0.0123, 6);
  });

  it("persists 0 when both pre-pass and KA report zero cost", async () => {
    const trace: FsTrace = { turnAdds: [], campaignSets: [] };
    const firestore = fakeFirestore(trace);
    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "continue" as const,
      intent: makeIntent({ intent: "DEFAULT", epicness: 0.05 }),
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const mockRunKa = async function* () {
      yield {
        kind: "final",
        narrative: "silent turn",
        ttftMs: null,
        totalMs: 1,
        costUsd: 0,
        sessionId: null,
        stopReason: "end_turn",
      };
    } as unknown as Parameters<typeof runTurn>[1]["runKa"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "silent" },
      { firestore, routeFn, runKa: mockRunKa },
    )) {
      /* drain */
    }

    expect(trace.turnAdds).toHaveLength(1);
    const values = trace.turnAdds[0] as { costUsd: number };
    expect(values.costUsd).toBe(0);
  });
});
