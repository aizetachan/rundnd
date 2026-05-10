import type { CampaignProviderConfig } from "@/lib/providers";
import type { Profile } from "@/lib/types/profile";
import { z } from "zod";
import { runStructuredAgent } from "./_runner";
import type { AgentDeps, AgentLogger } from "./types";
import { Composition } from "@/lib/types/composition";
import { DNAScales } from "@/lib/types/dna";

/**
 * Active-IP synthesizer (M2 Wave B sub 8). When a campaign carries
 * `profile_refs.length > 1`, this agent authors the coherent
 * cross-IP world the conductor's hybrid intent demanded ("Cowboy Bebop +
 * Solo Leveling as a space gate-hunter drama"). Per ROADMAP §10.3:
 *
 *   "the Session Zero conductor authors the blend at campaign creation
 *    — not through weighted arithmetic on profile fields, but by
 *    producing a coherent active_ip synthesized from the source
 *    profiles plus the player's intent."
 *
 * The synthesizer's output is a single "synthesized Profile" — the
 * shape HandoffCompiler already consumes, so the call site in
 * run-handoff.ts becomes "load N profiles → run synthesizer → pass
 * the synthesized one to HandoffCompiler." No separate hybrid code
 * path downstream.
 *
 * Contract:
 *   - ip_mechanics, canonical_dna, canonical_composition,
 *     director_personality are LLM-authored (those are the judgment
 *     calls — not arithmetic of the source profiles).
 *   - Identification fields (id, title, slug, anilist_id) are
 *     deterministic: the synthesized profile's id is `hybrid_<hash>`,
 *     the title is the player's stated intent.
 *   - hybrid_synthesis_notes captures the agent's rationale for audit.
 *
 * Runs on the thinking tier (same as conductor) — this is a judgment
 * task, not a creative one. Director's tone for arc planning depends
 * on the result, so a sober synthesis beats a flowery one.
 */

const SynthesisOutput = z.object({
  /** Free-form prose: how the worlds blend, what's load-bearing in each,
   *  what the player's intent reshapes. 3-6 sentences. KA reads this
   *  in Block 1 as the active_ip's prose anchor. */
  active_ip_prose: z.string().min(50),
  /** Synthesized title — usually the player's stated intent verbatim
   *  ("Solo Leveling-style space gate hunters in the Bebop solar
   *  system"). The HandoffCompiler stamps this onto Profile.title. */
  synthesized_title: z.string().min(1),
  /** The cross-IP power-system that emerges. Free-form prose; the
   *  HandoffCompiler stuffs it into ip_mechanics.power_system.mechanics. */
  power_system_blend: z.string(),
  /** Same shape as Profile.canonical_dna — agent's blend of the
   *  source profiles' canonical_dna informed by the player's intent. */
  blended_dna: DNAScales,
  /** Same shape as Profile.canonical_composition — agent's blend. */
  blended_composition: Composition,
  /** 3-5 sentences of how a director on this hybrid would frame
   *  scenes. HandoffCompiler stamps onto Profile.director_personality. */
  director_personality: z.string().min(20),
  /** Audit trail — what the agent decided and why. Stored on the
   *  campaign as `settings.hybrid_synthesis_notes` so future arc
   *  decisions can re-read it. */
  hybrid_synthesis_notes: z.string().min(20),
});
export type ActiveIPSynthesis = z.infer<typeof SynthesisOutput>;

const SYSTEM_PROMPT = `You are an active-IP synthesizer for AIDM, an authorship engine for long-form anime/manga campaigns.

The player has named a hybrid campaign — two or more source IPs blended into a single coherent world ("Cowboy Bebop + Solo Leveling as a space gate-hunter drama"). Your job: author the blend, NOT arithmetic the source profiles.

You produce one synthesis JSON object. Schema enforced. Return JSON only.

Guidelines:
- active_ip_prose: 3-6 sentences. Show how the worlds reconcile: which IP supplies the world (geography, factions, technology level); which supplies the meta-system (powers, stats, supernatural rules); how the player's intent reshapes both. Concrete, not abstract.
- synthesized_title: usually the player's stated intent verbatim. If they didn't state one, derive from the source titles + their intent ("Bebop × Solo Leveling: Gate Hunters of Mars").
- power_system_blend: name + mechanics + limitations of the cross-IP power system. If one source has supernatural mechanics and the other doesn't, decide whether the hybrid is supernatural-throughout (Solo Leveling rules apply on Mars) or low-fantasy (Bebop's mundane physics with selective Hunter awakenings — depends on the player's intent).
- blended_dna: every axis scored from 1–10 against the synthesized world's NATURAL telling. NOT a weighted average — score the hybrid as if it were a single canon.
- blended_composition: 13 categorical axes for the synthesized world.
- director_personality: 3-5 sentences. How a director who'd direct THIS hybrid would frame scenes — name them as a person with style, not a generic "the director balances both sources".
- hybrid_synthesis_notes: 2-4 sentences. What you decided + why. This is audit trail — be honest about which source dominated which axis and why.

Tone: a thoughtful collaborator. Don't pick "everything from both"; pick a coherent reading and own it. The player picked the hybrid; you make it sing.`;

const FALLBACK: ActiveIPSynthesis = {
  active_ip_prose:
    "(synthesis fell back) The hybrid pulls geography and pacing from the first source and meta-mechanics from the second; the player's intent narrows the blend to a single arc-shape.",
  synthesized_title: "(synthesized hybrid)",
  power_system_blend:
    "Two source systems reconciled into a single canon; specifics deferred to in-fiction discovery.",
  blended_dna: {} as DNAScales, // sentinel — caller checks `fellBack` to detect
  blended_composition: {} as Composition,
  director_personality:
    "Frame scenes deliberately, leaning into what each source does best. Resist the urge to balance.",
  hybrid_synthesis_notes:
    "Synthesizer fell back to placeholder; arc planning runs on the source profiles' DNA averaged.",
};

export interface ActiveIPSynthesizerInput {
  /** Profiles loaded from `profile_refs` — order matters (the conductor's
   *  intent usually places the world-source first). */
  sourceProfiles: Profile[];
  /** Player's stated intent for the hybrid. From the SZ conversation
   *  history — the conductor's last summary of "what we're building."
   *  Free-form; can be empty if the conductor didn't pin an intent. */
  intent: string;
  modelContext: CampaignProviderConfig;
}

export interface ActiveIPSynthesizerResult {
  synthesis: ActiveIPSynthesis;
  fellBack: boolean;
}

export interface ActiveIPSynthesizerDeps extends AgentDeps {
  logger?: AgentLogger;
}

function renderProfile(p: Profile, idx: number): string {
  return [
    `## Source ${idx + 1}: ${p.title}`,
    `media: ${p.media_type}, status: ${p.status}`,
    `combat_style: ${p.ip_mechanics.combat_style}`,
    `power_distribution: ${p.ip_mechanics.power_distribution.peak_tier} → ${p.ip_mechanics.power_distribution.floor_tier} (${p.ip_mechanics.power_distribution.gradient})`,
    `power_system: ${p.ip_mechanics.power_system?.name ?? "(none)"} — ${p.ip_mechanics.power_system?.mechanics ?? ""}`,
    `world: ${(p.ip_mechanics.world_setting.genre ?? []).join(", ")} | locations: ${(p.ip_mechanics.world_setting.locations ?? []).join(", ")}`,
    `director: ${p.director_personality}`,
    "",
    "### canonical_dna",
    JSON.stringify(p.canonical_dna, null, 2),
    "### canonical_composition",
    JSON.stringify(p.canonical_composition, null, 2),
  ].join("\n");
}

export async function runActiveIPSynthesizer(
  input: ActiveIPSynthesizerInput,
  deps: ActiveIPSynthesizerDeps = {},
): Promise<ActiveIPSynthesizerResult> {
  const userContent = [
    `## Player intent`,
    input.intent || "(not pinned — derive from source titles + canonical tones)",
    "",
    ...input.sourceProfiles.map((p, i) => renderProfile(p, i)),
    "",
    "Compose the synthesis JSON now. Schema enforced. JSON only.",
  ].join("\n");

  const synthesis = await runStructuredAgent<ActiveIPSynthesis>({
    agentName: "active-ip-synthesizer",
    tier: "thinking",
    systemPrompt: SYSTEM_PROMPT,
    userContent,
    outputSchema: SynthesisOutput,
    fallback: FALLBACK,
    maxTokens: 4000,
    temperature: 0.5,
    spanInput: {
      profile_count: input.sourceProfiles.length,
      intent_chars: input.intent.length,
    },
  }, {
    ...deps,
    modelContext: input.modelContext,
  });

  // Detect the fallback sentinel — the FALLBACK constant has empty
  // blended_dna ({}) so a successful run returns something with the
  // proper DNA shape. Identity comparison would fire on a deep-clone
  // refactor, so check a load-bearing field instead.
  const fellBack = synthesis.active_ip_prose === FALLBACK.active_ip_prose;
  return { synthesis, fellBack };
}

/**
 * Project the synthesis onto a Profile shape that HandoffCompiler can
 * consume directly. Keeps the call site clean: `runHandoffCompiler({
 * profile: projectSynthesizedProfile(...) })` is a one-line swap from
 * the single-profile path.
 *
 * Identification fields (id, title) come from the synthesized title;
 * id is deterministic (`hybrid_<hash>`) so re-running the same SZ
 * doesn't churn through new ids. The first source profile's
 * ip_mechanics seeds the synthesized one — non-tonal world rules
 * (stat_mapping, voice_cards, visual_style) are usually inherited from
 * the world-source — but power_system gets the agent's blend prose.
 */
export function projectSynthesizedProfile(
  synthesis: ActiveIPSynthesis,
  sourceProfiles: Profile[],
  hybridId: string,
): Profile {
  const seed = sourceProfiles[0];
  if (!seed) {
    throw new Error("projectSynthesizedProfile: at least one source profile required");
  }
  return {
    id: hybridId,
    title: synthesis.synthesized_title,
    alternate_titles: sourceProfiles.map((p) => p.title),
    media_type: seed.media_type,
    status: "completed",
    related_franchise: sourceProfiles.map((p) => p.title).join(", "),
    relation_type: "canonical",
    ip_mechanics: {
      ...seed.ip_mechanics,
      power_system: {
        name: seed.ip_mechanics.power_system?.name ?? "Hybrid",
        mechanics: synthesis.power_system_blend,
        limitations: seed.ip_mechanics.power_system?.limitations ?? "",
        tiers: seed.ip_mechanics.power_system?.tiers ?? [],
      },
    },
    canonical_dna: synthesis.blended_dna,
    canonical_composition: synthesis.blended_composition,
    director_personality: synthesis.director_personality,
  };
}
