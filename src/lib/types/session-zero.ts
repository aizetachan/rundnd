import { z } from "zod";
import { PowerTier } from "./profile";

/**
 * Session Zero state — the persisted form of an in-progress onboarding
 * conversation between the player and the SessionZeroConductor agent.
 * One doc per campaign at `campaigns/{campaignId}/sessionZero/state`.
 *
 * Lifecycle:
 *   not_started → in_progress (conductor opens turn 1)
 *   in_progress → ready_for_handoff (conductor calls finalizeSessionZero
 *                                    once hard requirements are met)
 *   ready_for_handoff → handoff_in_progress (HandoffCompiler running)
 *   handoff_in_progress → complete (OpeningStatePackage written; Campaign
 *                                   ready for first gameplay turn)
 *   any → abandoned (14-day inactivity cron, or user resets)
 *
 * Per ROADMAP §10.9 — provisional memory writes during the in_progress
 * phase carry `category: 'session_zero'` + `flag: 'provisional'`. On
 * successful handoff, HandoffCompiler emits authoritative replacements
 * + deletes provisional entries inside a Firestore transaction.
 */

export const SessionZeroPhase = z.enum([
  "not_started",
  "in_progress",
  "ready_for_handoff",
  "handoff_in_progress",
  "complete",
  "abandoned",
]);
export type SessionZeroPhase = z.infer<typeof SessionZeroPhase>;

export const CanonicalityMode = z.enum([
  "full_cast",
  "replaced_protagonist",
  "npcs_only",
  "inspired",
]);
export type CanonicalityMode = z.infer<typeof CanonicalityMode>;

/**
 * Conductor message — one entry in the conversation history. Mirrors the
 * shape KA's turn loop persists, simplified for SZ (no tool fingerprints,
 * no cost tracking inline; cost lands on the parent campaign budget).
 */
export const ConductorMessage = z.object({
  role: z.enum(["user", "conductor", "system"]),
  text: z.string(),
  /** Optional: tool calls the conductor made on this turn. Useful for the
   * resume UI to show "the conductor proposed X, you said yes" without
   * re-running the agent. */
  tool_calls: z
    .array(
      z.object({
        name: z.string(),
        args: z.unknown(),
        result: z.unknown().optional(),
      }),
    )
    .default([]),
  createdAt: z.date(),
});
export type ConductorMessage = z.infer<typeof ConductorMessage>;

/**
 * The character the player is building during Session Zero. All fields
 * nullable until the conductor has elicited them. CharacterDraft graduates
 * to a full `Character` row at handoff.
 */
export const CharacterAbility = z.object({
  name: z.string(),
  description: z.string(),
  limitations: z.string().nullable().optional(),
});
export type CharacterAbility = z.infer<typeof CharacterAbility>;

export const CharacterDraft = z.object({
  name: z.string().nullable().default(null),
  concept: z.string().nullable().default(null),
  power_tier: PowerTier.nullable().default(null),
  abilities: z.array(CharacterAbility).default([]),
  appearance: z.string().nullable().default(null),
  personality: z.string().nullable().default(null),
  backstory: z.string().nullable().default(null),
  voice_notes: z.string().nullable().default(null),
});
export type CharacterDraft = z.infer<typeof CharacterDraft>;

/**
 * Hard requirements gate — the conductor cannot call finalizeSessionZero
 * until every entry here is true. Soft requirements (backstory depth,
 * appearance polish) are nice-to-have.
 */
export const HardRequirements = z.object({
  has_profile_ref: z.boolean().default(false),
  has_canonicality_mode: z.boolean().default(false),
  has_character_name: z.boolean().default(false),
  has_character_concept: z.boolean().default(false),
  has_starting_situation: z.boolean().default(false),
});
export type HardRequirements = z.infer<typeof HardRequirements>;

export const SessionZeroState = z.object({
  campaignId: z.string(),
  ownerUid: z.string(),
  phase: SessionZeroPhase.default("not_started"),
  /** Profile slugs the conductor has committed to. One = single-source, multiple = hybrid (Wave B). */
  profile_refs: z.array(z.string()).default([]),
  canonicality_mode: CanonicalityMode.nullable().default(null),
  character_draft: CharacterDraft,
  conversation_history: z.array(ConductorMessage).default([]),
  /** Free-form narrative — "Spike's apartment in Tharsis; midnight; rain."
   *  Conductor populates as situation crystallizes. */
  starting_location: z.string().nullable().default(null),
  starting_situation: z.string().nullable().default(null),
  /** Hard requirements gate. */
  hard_requirements_met: HardRequirements,
  /** Currently-blocking issues the conductor is working through; cleared on handoff. */
  blocking_issues: z.array(z.string()).default([]),
  /** Conductor's running summary of the conversation — used as system prompt
   *  prefix on each turn so we don't re-bill the entire transcript every call.
   *  Updated by the conductor on each `commitField` call. */
  rolling_summary: z.string().default(""),
  /** Filled at handoff start; cleared/finalized at handoff complete. */
  handoff_started_at: z.date().nullable().default(null),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type SessionZeroState = z.infer<typeof SessionZeroState>;
