import type { Profile } from "@/lib/types/profile";
import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import {
  assembleSessionRuleLibraryGuidance,
  getArchetypeGuidance,
  getCompositionGuidance,
  getDnaGuidance,
  getPowerTierGuidance,
} from "../library";

/**
 * Rule library getters — tests against a fake Firestore that returns
 * fixture rows keyed on the query's category. Real DB-backed testing is
 * an acceptance-ritual target; these unit tests prove the getter logic +
 * snap-to-nearest + section rendering.
 */

interface FakeRow {
  category: string;
  axis: string | null;
  valueKey: string | null;
  content: string;
  /** Optional powerTier / ensembleArchetype fields used by the npcs subcollection fixture. */
  powerTier?: string;
  ensembleArchetype?: string;
}

interface FakeFirestoreOpts {
  rules: FakeRow[];
  npcs?: Array<{ powerTier?: string; ensembleArchetype?: string }>;
}

function fakeFirestore(opts: FakeFirestoreOpts): Firestore {
  const rules = opts.rules;
  const npcs = opts.npcs ?? [];

  function rulesQueryFor(filters: Record<string, unknown>): {
    where: (k: string, op: string, v: unknown) => ReturnType<typeof rulesQueryFor>;
    limit: (_n: number) => {
      get: () => Promise<{
        empty: boolean;
        docs: Array<{ data: () => Record<string, unknown> }>;
      }>;
    };
  } {
    const filtered = rules.filter((r) =>
      Object.entries(filters).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v),
    );
    return {
      where: (k: string, _op: string, v: unknown) => rulesQueryFor({ ...filters, [k]: v }),
      limit: (_n: number) => ({
        get: async () => ({
          empty: filtered.length === 0,
          docs: filtered.map((r) => ({ data: () => r as unknown as Record<string, unknown> })),
        }),
      }),
    };
  }

  const npcsCollection = {
    limit: (_n: number) => ({
      get: async () => ({
        empty: npcs.length === 0,
        docs: npcs.map((n) => ({ data: () => n as Record<string, unknown> })),
      }),
    }),
  };

  const campaignsCol = {
    doc: () => ({
      collection: (_name: string) => npcsCollection,
    }),
  };

  return {
    collection: (name: string) => {
      if (name === "ruleLibraryChunks") {
        return {
          where: (k: string, _op: string, v: unknown) => rulesQueryFor({ [k]: v }),
        };
      }
      if (name === "campaigns") return campaignsCol;
      throw new Error(`unexpected collection ${name}`);
    },
  } as unknown as Firestore;
}

describe("getDnaGuidance — snap-to-nearest", () => {
  it("snaps value 0-2 to '1'", async () => {
    const fs = fakeFirestore({
      rules: [
        { category: "dna", axis: "optimism", valueKey: "1", content: "low optimism guidance" },
      ],
    });
    expect(await getDnaGuidance(fs, "optimism", 0)).toBe("low optimism guidance");
    expect(await getDnaGuidance(fs, "optimism", 2)).toBe("low optimism guidance");
  });

  it("snaps value 3-7 to '5'", async () => {
    const fs = fakeFirestore({
      rules: [
        { category: "dna", axis: "optimism", valueKey: "5", content: "mid optimism guidance" },
      ],
    });
    expect(await getDnaGuidance(fs, "optimism", 3)).toBe("mid optimism guidance");
    expect(await getDnaGuidance(fs, "optimism", 5)).toBe("mid optimism guidance");
    expect(await getDnaGuidance(fs, "optimism", 7)).toBe("mid optimism guidance");
  });

  it("snaps value 8-10 to '10'", async () => {
    const fs = fakeFirestore({
      rules: [
        { category: "dna", axis: "optimism", valueKey: "10", content: "high optimism guidance" },
      ],
    });
    expect(await getDnaGuidance(fs, "optimism", 8)).toBe("high optimism guidance");
    expect(await getDnaGuidance(fs, "optimism", 10)).toBe("high optimism guidance");
  });

  it("returns null when no row matches", async () => {
    const fs = fakeFirestore({ rules: [] });
    expect(await getDnaGuidance(fs, "optimism", 5)).toBe(null);
  });
});

describe("getCompositionGuidance", () => {
  it("looks up by (category=composition, axis, valueKey)", async () => {
    const fs = fakeFirestore({
      rules: [
        {
          category: "composition",
          axis: "tension_source",
          valueKey: "existential",
          content: "existential tension guidance",
        },
      ],
    });
    expect(await getCompositionGuidance(fs, "tension_source", "existential")).toBe(
      "existential tension guidance",
    );
  });

  it("returns null on miss", async () => {
    const fs = fakeFirestore({ rules: [] });
    expect(await getCompositionGuidance(fs, "tension_source", "nonexistent")).toBe(null);
  });
});

describe("getPowerTierGuidance", () => {
  it("looks up by (category=power_tier, axis=null, valueKey=T-number)", async () => {
    const fs = fakeFirestore({
      rules: [
        {
          category: "power_tier",
          axis: null,
          valueKey: "T5",
          content: "tier 5 guidance",
        },
      ],
    });
    expect(await getPowerTierGuidance(fs, "T5")).toBe("tier 5 guidance");
  });
});

describe("getArchetypeGuidance", () => {
  it("looks up by (category=archetype, axis=null, valueKey=archetype name)", async () => {
    const fs = fakeFirestore({
      rules: [
        {
          category: "archetype",
          axis: null,
          valueKey: "struggler",
          content: "struggler guidance",
        },
      ],
    });
    expect(await getArchetypeGuidance(fs, "struggler")).toBe("struggler guidance");
  });
});

describe("assembleSessionRuleLibraryGuidance — bundle shape", () => {
  // Minimal profile + active state for bundle assembly
  const profile: Profile = {
    id: "p1",
    title: "Test",
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
        ensemble_focus: false,
        slow_burn_romance: false,
      },
      world_setting: { genre: [], locations: [], factions: [] },
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
    director_personality: "test",
  };

  it("returns a non-empty bundle with sections populated when DB has content", async () => {
    // profile.canonical_dna.optimism = 3 → snaps to valueKey "5".
    // profile.canonical_composition.tension_source = "existential".
    const fs = fakeFirestore({
      rules: [
        {
          category: "dna",
          axis: "optimism",
          valueKey: "5",
          content: "optimism 5 content",
        },
        {
          category: "composition",
          axis: "tension_source",
          valueKey: "existential",
          content: "existential tension content",
        },
      ],
    });
    const bundle = await assembleSessionRuleLibraryGuidance(fs, {
      profile,
      characterPowerTier: "T7",
      campaignId: "c-1",
    });
    expect(bundle).toContain("DNA axes — tonal pressures for this campaign");
    expect(bundle).toContain("Composition — narrative framing for this campaign");
    expect(bundle).toContain("optimism = 3");
    expect(bundle).toContain("optimism 5 content");
    expect(bundle).toContain("tension_source: existential");
    expect(bundle).toContain("existential tension content");
  });

  it("returns an empty string when DB has no matching content (graceful degradation)", async () => {
    const fs = fakeFirestore({ rules: [] });
    const bundle = await assembleSessionRuleLibraryGuidance(fs, {
      profile,
      characterPowerTier: null,
      campaignId: "c-1",
    });
    // With no rows in any section, every section is empty; sections joined
    // is empty.
    expect(bundle).toBe("");
  });
});
