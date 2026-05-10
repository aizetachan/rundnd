import { getPrompt } from "@/lib/prompts";
import {
  AnimationInputs,
  CanonRules,
  OpeningCastMember,
  OpeningSituation,
  type OpeningStatePackage,
  PlayerCharacter,
  RelationshipEdge,
  WorldContext,
} from "@/lib/types/opening-state-package";
import type { Profile } from "@/lib/types/profile";
import type { ConductorMessage, SessionZeroState } from "@/lib/types/session-zero";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * HandoffCompiler — turns a finalized Session Zero into an authoritative
 * `OpeningStatePackage`. Runs once per SZ, after the conductor calls
 * `finalize_session_zero` and the doc phase flips to `ready_for_handoff`.
 *
 * Architecture:
 *   - Anthropic-only at M2. Provider guard mirrors KA + conductor.
 *   - Structured-output runner (not Agent SDK with MCP) — no streaming
 *     and no tool-calling; HandoffCompiler emits one JSON synthesis blob,
 *     downstream code merges deterministic fields (metadata, character,
 *     readiness, DNA/composition from the profile).
 *   - Thinking tier (consistent with the conductor + the v3-respect
 *     framing: this is editorial work, not narration).
 *
 * Why split LLM vs deterministic: pieces of OpeningStatePackage are
 * pure transformations of conductor-elicited data
 * (player_character ← character_draft, package_metadata ← request
 * context, director_inputs.initial_dna ← profile.canonical_dna). Asking
 * the LLM to round-trip those wastes tokens and risks the model
 * "improving" data the player already confirmed. Synthesis fields
 * (opening_situation, opening_cast, hooks, tone_anchors, etc.) are
 * what require judgment — those go through the LLM.
 */

/**
 * Subset schema the LLM must emit. Excludes fields filled in code
 * (package_metadata, readiness, player_character, director_inputs.initial_dna,
 * director_inputs.initial_composition).
 */
const HandoffSynthesis = z.object({
  opening_situation: OpeningSituation,
  world_context: WorldContext,
  opening_cast: z.array(OpeningCastMember).default([]),
  canon_rules: CanonRules,
  director_inputs: z.object({
    hooks: z.array(z.string()).default([]),
    tone_anchors: z.array(z.string()).default([]),
    pacing_cues: z.array(z.string()).default([]),
  }),
  animation_inputs: AnimationInputs,
  hard_constraints: z.array(z.string()).default([]),
  soft_targets: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  relationship_graph: z.array(RelationshipEdge).default([]),
  contradictions_summary: z.array(z.string()).default([]),
  orphan_facts: z.array(z.string()).default([]),
});
export type HandoffSynthesis = z.infer<typeof HandoffSynthesis>;

// The runner returns `config.fallback` by reference; we identity-
// compare against this sentinel below. The `satisfies` marker keeps
// the inferred type narrow so `runHandoffCompiler` will fail to
// compile if the fallback shape ever stops matching the schema; the
// `as const`-style readonly is intentional — never mutate this.
const SYNTHESIS_FALLBACK = {
  opening_situation: {
    starting_location: "(unset)",
    time_context: "(unset)",
    immediate_situation:
      "The scene opens. (handoff synthesis fell back — player can /meta to repair)",
    scene_objective: "(unset)",
    scene_question: "(unset)",
    expected_initial_motion: "(unset)",
    forbidden_opening_moves: [],
  },
  world_context: {
    geography: null,
    factions: [],
    political_climate: null,
    supernatural_rules: null,
  },
  opening_cast: [],
  canon_rules: {
    timeline_mode: "unspecified",
    divergence_notes: null,
    forbidden_contradictions: [],
  },
  director_inputs: {
    hooks: [],
    tone_anchors: [],
    pacing_cues: [],
  },
  animation_inputs: {
    visual_style_notes: null,
    character_pose_notes: null,
    environment_details: null,
  },
  hard_constraints: [],
  soft_targets: [],
  uncertainties: [],
  relationship_graph: [],
  contradictions_summary: [],
  orphan_facts: [],
} satisfies HandoffSynthesis;

export interface HandoffCompilerInput {
  campaignId: string;
  /** Loaded SZ state. Caller verifies phase=ready_for_handoff before invoking. */
  szState: SessionZeroState;
  /** The single profile the campaign resolves to. Hybrid synthesis lands in Wave B. */
  profile: Profile;
}

export interface HandoffCompilerResult {
  /** Fully validated, ready to persist + hand to KA. */
  package: OpeningStatePackage;
  /** True when the LLM call hit the fallback. Caller can flag this in readiness. */
  fellBack: boolean;
}

function renderTranscript(history: ConductorMessage[]): string {
  if (history.length === 0) return "(empty)";
  return history
    .map((m) => {
      const head = `[${m.role}]`;
      const body = m.text || "";
      const tools =
        m.tool_calls && m.tool_calls.length > 0
          ? m.tool_calls.map((c) => `  · ${c.name}(${JSON.stringify(c.args)})`).join("\n")
          : "";
      return [head, body, tools].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function buildUserContent(input: HandoffCompilerInput): string {
  const sz = input.szState;
  const draft = sz.character_draft;
  return [
    `campaign_id: ${input.campaignId}`,
    `profile_title: ${input.profile.title}`,
    `profile_id: ${input.profile.id}`,
    `canonicality_mode: ${sz.canonicality_mode ?? "(unset — fall back to inspired)"}`,
    "",
    "## Player character draft",
    JSON.stringify(draft, null, 2),
    "",
    "## Profile (IP mechanics, canonical tonal, director personality)",
    JSON.stringify(
      {
        ip_mechanics: input.profile.ip_mechanics,
        canonical_dna: input.profile.canonical_dna,
        canonical_composition: input.profile.canonical_composition,
        director_personality: input.profile.director_personality,
      },
      null,
      2,
    ),
    "",
    "## Conductor's starting-situation notes",
    `starting_location: ${sz.starting_location ?? "(unset)"}`,
    `starting_situation: ${sz.starting_situation ?? "(unset)"}`,
    "",
    "## Session Zero transcript",
    renderTranscript(sz.conversation_history),
    "",
    "Compile the synthesis JSON now. Schema enforced — return JSON only.",
  ].join("\n");
}

/**
 * Build the deterministic-fields side of the package: metadata,
 * readiness, player_character (from character_draft), and the
 * DNA/composition slot of director_inputs (from the profile).
 */
function buildDeterministic(
  input: HandoffCompilerInput,
  fellBack: boolean,
): {
  metadata: OpeningStatePackage["package_metadata"];
  readiness: OpeningStatePackage["readiness"];
  player_character: OpeningStatePackage["player_character"];
  initial_dna: OpeningStatePackage["director_inputs"]["initial_dna"];
  initial_composition: OpeningStatePackage["director_inputs"]["initial_composition"];
} {
  const sz = input.szState;
  // CharacterDraft has nullable fields (the schema permits in-flight
  // partials). At handoff the conductor's hard-requirements gate has
  // already enforced name + concept; coerce the remaining fields with
  // tight fallbacks so we satisfy PlayerCharacter's strict schema
  // without dropping handoff over a missing soft field.
  const draft = sz.character_draft;
  const player_character = PlayerCharacter.parse({
    name: draft.name ?? "(unnamed)",
    concept: draft.concept ?? "(unspecified)",
    appearance: draft.appearance ?? "(unspecified)",
    abilities: draft.abilities.map((a) => ({
      name: a.name,
      description: a.description,
      limitations: a.limitations ?? null,
    })),
    personality: draft.personality ?? "(unspecified)",
    backstory: draft.backstory ?? "(unspecified)",
    voice_notes: draft.voice_notes ?? null,
  });

  return {
    metadata: {
      session_id: input.campaignId,
      campaign_id: input.campaignId,
      schema_version: "v4.0",
      created_at: new Date(),
      profile_id: input.profile.id,
      canonicality_mode: sz.canonicality_mode ?? "inspired",
    },
    readiness: {
      handoff_status: fellBack ? "warnings_only" : "ready",
      blocking_issues: [],
      warnings: fellBack
        ? ["HandoffCompiler synthesis fell back; opening scene fields are placeholders."]
        : [],
      missing_but_nonblocking: [],
    },
    player_character,
    initial_dna: input.profile.canonical_dna,
    initial_composition: input.profile.canonical_composition,
  };
}

/**
 * Run HandoffCompiler. Returns the validated OpeningStatePackage plus a
 * `fellBack` flag the orchestrator can use to mark `readiness` and
 * decide whether to persist or revert SZ to `in_progress`.
 *
 * Provider-gated: throws on non-Anthropic providers. Same shape as
 * runKeyAnimator + runChronicler + runSessionZeroConductor.
 */
export async function runHandoffCompiler(
  input: HandoffCompilerInput,
  deps: AgentRunnerDeps = {},
): Promise<HandoffCompilerResult> {
  const ctx = deps.modelContext;
  if (ctx && ctx.provider !== "anthropic") {
    throw new Error(
      `HandoffCompiler on the structured runner only supports provider="anthropic" at M2 (got "${ctx.provider}"). Other providers land alongside their KA implementations (M3.5 / M5.5).`,
    );
  }

  const promptId = "agents/handoff-compiler";
  const systemPrompt = getPrompt(promptId).content;
  const userContent = buildUserContent(input);

  // Detect fallback via identity comparison against the sentinel. Hinges
  // on `_runner.ts` returning `config.fallback` by reference — see the
  // `satisfies` marker on SYNTHESIS_FALLBACK above so a future refactor
  // that deep-clones the fallback breaks loudly via the type system.
  const synthesis = await runStructuredAgent<HandoffSynthesis>(
    {
      agentName: "handoff-compiler",
      tier: "thinking",
      systemPrompt,
      promptId,
      userContent,
      outputSchema: HandoffSynthesis,
      fallback: SYNTHESIS_FALLBACK,
      maxTokens: 4096,
      thinkingBudget: 4096,
      spanInput: {
        campaign_id: input.campaignId,
        profile_id: input.profile.id,
        canonicality_mode: input.szState.canonicality_mode,
      },
    },
    deps,
  );

  const fellBack = synthesis === SYNTHESIS_FALLBACK;
  const det = buildDeterministic(input, fellBack);

  const packageOut: OpeningStatePackage = {
    package_metadata: det.metadata,
    readiness: det.readiness,
    player_character: det.player_character,
    opening_situation: synthesis.opening_situation,
    world_context: synthesis.world_context,
    opening_cast: synthesis.opening_cast,
    canon_rules: synthesis.canon_rules,
    director_inputs: {
      hooks: synthesis.director_inputs.hooks,
      tone_anchors: synthesis.director_inputs.tone_anchors,
      pacing_cues: synthesis.director_inputs.pacing_cues,
      initial_dna: det.initial_dna,
      initial_composition: det.initial_composition,
    },
    animation_inputs: synthesis.animation_inputs,
    hard_constraints: synthesis.hard_constraints,
    soft_targets: synthesis.soft_targets,
    uncertainties: synthesis.uncertainties,
    relationship_graph: synthesis.relationship_graph,
    contradictions_summary: synthesis.contradictions_summary,
    orphan_facts: synthesis.orphan_facts,
  };

  return { package: packageOut, fellBack };
}
