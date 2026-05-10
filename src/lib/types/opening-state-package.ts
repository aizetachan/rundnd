import { z } from "zod";
import { Composition } from "./composition";
import { DNAScales } from "./dna";
import { CanonicalityMode } from "./session-zero";

/**
 * OpeningStatePackage — the typed contract the HandoffCompiler emits
 * at the end of Session Zero. Every downstream subsystem (Director,
 * Chronicler, KA, WorldBuilder, ProductionAgent, memory writer) reads
 * this package as the authoritative spec for the campaign's first
 * gameplay turn.
 *
 * Per ROADMAP §10.7. Versioned by `package_metadata.schema_version`;
 * supersede pointers + content_hash dedup live on the parent artifact
 * record (Firestore doc), not in this schema.
 */

export const HandoffStatus = z.enum(["ready", "warnings_only", "blocked"]);
export type HandoffStatus = z.infer<typeof HandoffStatus>;

export const PackageMetadata = z.object({
  session_id: z.string(),
  campaign_id: z.string(),
  schema_version: z.string().default("v4.0"),
  created_at: z.date(),
  profile_id: z.string().nullable(),
  canonicality_mode: CanonicalityMode,
});

export const Readiness = z.object({
  handoff_status: HandoffStatus,
  blocking_issues: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  missing_but_nonblocking: z.array(z.string()).default([]),
});

export const OspCharacterAbility = z.object({
  name: z.string(),
  description: z.string(),
  limitations: z.string().nullable(),
});

export const PlayerCharacter = z.object({
  name: z.string(),
  concept: z.string(),
  appearance: z.string(),
  abilities: z.array(OspCharacterAbility).default([]),
  personality: z.string(),
  backstory: z.string(),
  voice_notes: z.string().nullable(),
});

/**
 * Critical — seeds Director's first arc state and KA's first scene.
 * Forbidden_opening_moves is the WB-style hard guard ("don't start
 * mid-combat unless the situation calls for it").
 */
export const OpeningSituation = z.object({
  starting_location: z.string(),
  time_context: z.string(),
  immediate_situation: z.string(),
  scene_objective: z.string(),
  scene_question: z.string(),
  expected_initial_motion: z.string(),
  forbidden_opening_moves: z.array(z.string()).default([]),
});

export const WorldContext = z.object({
  geography: z.string().nullable(),
  factions: z.array(z.string()).default([]),
  political_climate: z.string().nullable(),
  supernatural_rules: z.string().nullable(),
});

export const OpeningCastMember = z.object({
  name: z.string(),
  role: z.string(),
  brief: z.string(),
  faction: z.string().nullable(),
});

export const CanonRules = z.object({
  timeline_mode: z.enum(["pre-canon", "post-canon", "alternate", "unspecified"]),
  divergence_notes: z.string().nullable(),
  forbidden_contradictions: z.array(z.string()).default([]),
});

export const DirectorInputs = z.object({
  hooks: z.array(z.string()).default([]),
  tone_anchors: z.array(z.string()).default([]),
  pacing_cues: z.array(z.string()).default([]),
  initial_dna: DNAScales,
  initial_composition: Composition,
});

export const AnimationInputs = z.object({
  visual_style_notes: z.string().nullable(),
  character_pose_notes: z.string().nullable(),
  environment_details: z.string().nullable(),
});

export const RelationshipEdge = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  notes: z.string().nullable(),
});

export const OpeningStatePackage = z.object({
  package_metadata: PackageMetadata,
  readiness: Readiness,
  player_character: PlayerCharacter,
  opening_situation: OpeningSituation,
  world_context: WorldContext,
  opening_cast: z.array(OpeningCastMember).default([]),
  canon_rules: CanonRules,
  director_inputs: DirectorInputs,
  animation_inputs: AnimationInputs,
  /** Non-negotiable facts ("character's name is Tanjiro, must not change"). */
  hard_constraints: z.array(z.string()).default([]),
  /** Quality guidance ("lean into found-family trope"). */
  soft_targets: z.array(z.string()).default([]),
  /** Explicitly unresolved threads — narrative hooks the player will discover. */
  uncertainties: z.array(z.string()).default([]),
  relationship_graph: z.array(RelationshipEdge).default([]),
  /** Conductor's audit trail — issues found mid-SZ that didn't block handoff. */
  contradictions_summary: z.array(z.string()).default([]),
  orphan_facts: z.array(z.string()).default([]),
});
export type OpeningStatePackage = z.infer<typeof OpeningStatePackage>;
