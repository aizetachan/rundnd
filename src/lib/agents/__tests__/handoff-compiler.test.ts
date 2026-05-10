import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockAnthropic } from "@/lib/llm/mock/testing";
import { type CampaignProviderConfig, anthropicFallbackConfig } from "@/lib/providers";
import { OpeningStatePackage } from "@/lib/types/opening-state-package";
import { Profile } from "@/lib/types/profile";
import type { SessionZeroState } from "@/lib/types/session-zero";
import jsYaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { type HandoffSynthesis, runHandoffCompiler } from "../handoff-compiler";

/**
 * HandoffCompiler unit tests. Cover:
 *   - Provider guard (Anthropic-only at M2)
 *   - LLM synthesis merges deterministically with profile + character
 *     draft inputs into a fully-validated OpeningStatePackage
 *   - Fallback path stamps readiness=warnings_only and surfaces a flag
 *
 * Real Agent SDK + Firestore wiring lives in the orchestrator
 * (`run-handoff.ts`) and is exercised by the integration sweep when
 * sub 4 lands. Here we test only the agent's transformation contract.
 */

function loadBebop(): Profile {
  const raw = readFileSync(
    join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml"),
    "utf8",
  );
  return Profile.parse(jsYaml.load(raw));
}

function baseSzState(overrides: Partial<SessionZeroState> = {}): SessionZeroState {
  const now = new Date();
  return {
    campaignId: "c-1",
    ownerUid: "u-1",
    phase: "ready_for_handoff",
    profile_refs: ["cowboy-bebop"],
    canonicality_mode: "replaced_protagonist",
    character_draft: {
      name: "Spike Spiegel",
      concept: "Bounty hunter, ex-syndicate enforcer",
      power_tier: "T9",
      abilities: [
        {
          name: "Jeet Kune Do",
          description: "Fluid striking art",
          limitations: "No supernatural enhancement",
        },
      ],
      appearance: "Tall, lean, hair in his face",
      personality: "Quiet, dry humor",
      backstory: "Lost a partner in the syndicate",
      voice_notes: "Resigned to dying, finds it funny",
    },
    conversation_history: [],
    starting_location: "The Bebop, docked",
    starting_situation: "Spike's waking up; the bounty board is blinking.",
    hard_requirements_met: {
      has_profile_ref: true,
      has_canonicality_mode: true,
      has_character_name: true,
      has_character_concept: true,
      has_starting_situation: true,
    },
    blocking_issues: [],
    rolling_summary: "",
    handoff_started_at: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const VALID_SYNTHESIS: HandoffSynthesis = {
  opening_situation: {
    starting_location: "The Bebop, drifting in Ganymede traffic",
    time_context: "Morning; station-time approximate",
    immediate_situation:
      "Spike wakes up to a blinking bounty terminal. Faye and Jet are arguing in the galley.",
    scene_objective: "Decide whether to take the new bounty",
    scene_question: "Will Spike commit, or stall again?",
    expected_initial_motion: "Spike checks the bounty terminal or walks to the galley",
    forbidden_opening_moves: ["Don't open mid-combat"],
  },
  world_context: {
    geography: "Solar system, post-gate disaster",
    factions: ["Red Dragons", "ISSP", "Bebop crew"],
    political_climate: "Decentralized; bounty hunters fill enforcement gaps",
    supernatural_rules: null,
  },
  opening_cast: [
    {
      name: "Jet Black",
      role: "Crewmate, ex-cop",
      brief: "Pragmatic, holds the Bebop together",
      faction: "Bebop crew",
    },
  ],
  canon_rules: {
    timeline_mode: "alternate",
    divergence_notes: "Player drives Spike's choices; canon ending unfixed.",
    forbidden_contradictions: ["Spike's hand is real and present"],
  },
  director_inputs: {
    hooks: ["A bounty leads back to Spike's syndicate past"],
    tone_anchors: ["Jazz-blue noir", "Existential humor"],
    pacing_cues: ["Episode-of-the-week early; arc tension grows mid-campaign"],
  },
  animation_inputs: {
    visual_style_notes: "Hand-drawn anime; smoky color palette",
    character_pose_notes: "Slouched, hands in pockets",
    environment_details: "Cluttered ship interior, neon outside",
  },
  hard_constraints: ["Spike never wields supernatural powers"],
  soft_targets: ["Lean into found-family moments with Jet"],
  uncertainties: ["Does Vicious know Spike is alive?"],
  relationship_graph: [
    { from: "Spike Spiegel", to: "Jet Black", kind: "ally", notes: "Trust forged on the Bebop" },
  ],
  contradictions_summary: [],
  orphan_facts: [],
};

describe("runHandoffCompiler", () => {
  it("throws on non-Anthropic providers", async () => {
    const google: CampaignProviderConfig = {
      provider: "google",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gemini-3.1-flash-lite-preview",
        thinking: "gemini-3.1-pro-preview",
        creative: "gemini-3.1-pro-preview",
      },
    };
    await expect(
      runHandoffCompiler(
        { campaignId: "c-1", szState: baseSzState(), profile: loadBebop() },
        { modelContext: google },
      ),
    ).rejects.toThrow(/google/i);
  });

  it("merges LLM synthesis with deterministic fields into a valid OpeningStatePackage", async () => {
    const anthropic = createMockAnthropic([{ text: JSON.stringify(VALID_SYNTHESIS) }]);
    const result = await runHandoffCompiler(
      { campaignId: "c-1", szState: baseSzState(), profile: loadBebop() },
      { modelContext: anthropicFallbackConfig(), anthropic },
    );
    // Schema-valid all the way down.
    expect(() => OpeningStatePackage.parse(result.package)).not.toThrow();
    expect(result.fellBack).toBe(false);

    // Deterministic fields filled from inputs (not from the LLM).
    expect(result.package.player_character.name).toBe("Spike Spiegel");
    expect(result.package.package_metadata.profile_id).toBe(loadBebop().id);
    expect(result.package.package_metadata.canonicality_mode).toBe("replaced_protagonist");
    expect(result.package.readiness.handoff_status).toBe("ready");

    // initial_dna + initial_composition come from the profile, not the synthesis.
    expect(result.package.director_inputs.initial_dna).toEqual(loadBebop().canonical_dna);
    expect(result.package.director_inputs.initial_composition).toEqual(
      loadBebop().canonical_composition,
    );

    // Synthesis fields land in the package.
    expect(result.package.opening_situation.starting_location).toContain("Bebop");
    expect(result.package.director_inputs.hooks.length).toBeGreaterThan(0);
  });

  it("falls back gracefully when the LLM returns malformed JSON twice", async () => {
    // runStructuredAgent retries once; two bad responses → fallback.
    const anthropic = createMockAnthropic([{ text: "not json" }, { text: "still not json" }]);
    const result = await runHandoffCompiler(
      { campaignId: "c-1", szState: baseSzState(), profile: loadBebop() },
      { modelContext: anthropicFallbackConfig(), anthropic },
    );
    expect(result.fellBack).toBe(true);
    expect(result.package.readiness.handoff_status).toBe("warnings_only");
    expect(result.package.readiness.warnings.length).toBeGreaterThan(0);
    // Even on fallback the deterministic fields land — the player still
    // gets a usable package, just with placeholder synthesis fields.
    expect(result.package.player_character.name).toBe("Spike Spiegel");
    expect(result.package.director_inputs.initial_dna).toEqual(loadBebop().canonical_dna);
  });

  it("coerces partial CharacterDraft fields with placeholders rather than failing schema", async () => {
    const sz = baseSzState({
      character_draft: {
        name: "Lyle",
        concept: "Bounty hunter",
        power_tier: null,
        abilities: [],
        appearance: null,
        personality: null,
        backstory: null,
        voice_notes: null,
      },
    });
    const anthropic = createMockAnthropic([{ text: JSON.stringify(VALID_SYNTHESIS) }]);
    const result = await runHandoffCompiler(
      { campaignId: "c-1", szState: sz, profile: loadBebop() },
      { modelContext: anthropicFallbackConfig(), anthropic },
    );
    expect(result.package.player_character.name).toBe("Lyle");
    // Soft fields filled with "(unspecified)" so the strict
    // PlayerCharacter schema parses.
    expect(result.package.player_character.appearance).toBe("(unspecified)");
    expect(result.package.player_character.backstory).toBe("(unspecified)");
  });
});
