import { CAMPAIGN_SUB, COL, SESSION_ZERO_DOC_ID } from "@/lib/firestore";
import { PowerTier } from "@/lib/types/profile";
import { CanonicalityMode, CharacterAbility } from "@/lib/types/session-zero";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Persist a single confirmed field of the SessionZeroState /
 * CharacterDraft to Firestore. The conductor calls this after the
 * player has explicitly chosen / confirmed the value (vs proposing
 * options or asking questions).
 *
 * Why one tool with a discriminated input vs 12 tools: the agent only
 * needs one mental model — "I commit a field by name." Adding 12
 * separate tool surfaces would balloon the tool list and force the
 * agent to memorize 12 input schemas. The trade-off is `value` is
 * loosely typed at the tool boundary (`z.unknown()`); execute()
 * tightens it per-field.
 *
 * Hard-requirements bookkeeping: each commit recomputes the relevant
 * `hard_requirements_met.*` flag in the same write. The conductor can
 * read the result to know whether finalize_session_zero is now
 * eligible.
 */
const FieldName = z.enum([
  // CharacterDraft scalars
  "character_name",
  "character_concept",
  "power_tier",
  "appearance",
  "personality",
  "backstory",
  "voice_notes",
  "abilities",
  // SessionZeroState scalars
  "starting_location",
  "starting_situation",
  "canonicality_mode",
  "profile_refs",
]);
type FieldName = z.infer<typeof FieldName>;

const InputSchema = z.object({
  field: FieldName,
  /**
   * Field-specific value. The execute() function validates against
   * the per-field schema below; passing an incompatible shape throws
   * a ZodError. Loose typing at the tool boundary keeps the input
   * schema MCP-compatible (single z.object) without ballooning to a
   * z.discriminatedUnion that doesn't expose `.shape`.
   */
  value: z.unknown(),
});

const OutputSchema = z.object({
  field: FieldName,
  committed: z.literal(true),
  /**
   * The hard-requirements snapshot AFTER this commit. Conductor checks
   * this to know whether finalize_session_zero is now unblocked.
   */
  hard_requirements_met: z.object({
    has_profile_ref: z.boolean(),
    has_canonicality_mode: z.boolean(),
    has_character_name: z.boolean(),
    has_character_concept: z.boolean(),
    has_starting_situation: z.boolean(),
  }),
});

/**
 * Per-field validation. Each entry maps the FieldName to its Zod
 * schema and to the dotted Firestore path the value lands at. Adding
 * a new field means: extend FieldName + add an entry here.
 */
type FieldSpec = {
  schema: z.ZodTypeAny;
  /**
   * Update payload to merge into the SZ doc. Dotted keys for nested
   * paths (Firestore set/update treats dots as nesting). The function
   * receives the validated value so callers can wrap into arrays etc.
   */
  toUpdate: (value: unknown) => Record<string, unknown>;
  /**
   * Optional: which hard-requirement flag this commit flips to true.
   * Returning undefined means the field doesn't gate finalization
   * (e.g. appearance, voice_notes — soft requirements).
   */
  hardRequirementKey?:
    | "has_profile_ref"
    | "has_canonicality_mode"
    | "has_character_name"
    | "has_character_concept"
    | "has_starting_situation";
};

const FIELD_SPECS: Record<FieldName, FieldSpec> = {
  character_name: {
    schema: z.string().min(1),
    toUpdate: (v) => ({ "character_draft.name": v }),
    hardRequirementKey: "has_character_name",
  },
  character_concept: {
    schema: z.string().min(1),
    toUpdate: (v) => ({ "character_draft.concept": v }),
    hardRequirementKey: "has_character_concept",
  },
  power_tier: {
    schema: PowerTier,
    toUpdate: (v) => ({ "character_draft.power_tier": v }),
  },
  appearance: {
    schema: z.string().min(1),
    toUpdate: (v) => ({ "character_draft.appearance": v }),
  },
  personality: {
    schema: z.string().min(1),
    toUpdate: (v) => ({ "character_draft.personality": v }),
  },
  backstory: {
    schema: z.string().min(1),
    toUpdate: (v) => ({ "character_draft.backstory": v }),
  },
  voice_notes: {
    schema: z.string().min(1),
    toUpdate: (v) => ({ "character_draft.voice_notes": v }),
  },
  abilities: {
    schema: z.array(CharacterAbility).min(1),
    toUpdate: (v) => ({ "character_draft.abilities": v }),
  },
  starting_location: {
    schema: z.string().min(1),
    toUpdate: (v) => ({ starting_location: v }),
  },
  starting_situation: {
    schema: z.string().min(1),
    toUpdate: (v) => ({ starting_situation: v }),
    hardRequirementKey: "has_starting_situation",
  },
  canonicality_mode: {
    schema: CanonicalityMode,
    toUpdate: (v) => ({ canonicality_mode: v }),
    hardRequirementKey: "has_canonicality_mode",
  },
  profile_refs: {
    schema: z.array(z.string().min(1)).min(1),
    toUpdate: (v) => ({ profile_refs: v }),
    hardRequirementKey: "has_profile_ref",
  },
};

const HARD_REQUIREMENT_KEYS = [
  "has_profile_ref",
  "has_canonicality_mode",
  "has_character_name",
  "has_character_concept",
  "has_starting_situation",
] as const;

export const commitFieldTool = registerTool({
  name: "commit_field",
  description:
    "Persist one confirmed field of the character draft or campaign setup to the SZ doc. Call ONLY after the player has explicitly chosen the value. Returns the updated hard-requirements snapshot so you know when finalize_session_zero is eligible.",
  layer: "session_zero",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) {
      throw new Error("commit_field: ctx.firestore not provided");
    }
    const spec = FIELD_SPECS[input.field];
    if (!spec) {
      // Unreachable under Zod validation but keeps the type system honest.
      throw new Error(`commit_field: unknown field "${input.field}"`);
    }
    const validated = spec.schema.parse(input.value);

    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.sessionZero)
      .doc(SESSION_ZERO_DOC_ID);

    // Compute the post-commit hard-requirements snapshot inside a
    // transaction so a concurrent commit_field for a different
    // requirement doesn't race a stale read into the response. The SZ
    // doc is created by the entry-point handler (sub 3) before the
    // conductor runs — a missing doc means the caller skipped that
    // step, and we'd silently create a partial doc lacking required
    // fields (campaignId, ownerUid, phase, …). Throw to match
    // finalize_session_zero's contract.
    const hardRequirementsMet = await ctx.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(
          "commit_field: no SZ doc for this campaign — sub 3 / sub 6 should create it before the conductor runs",
        );
      }
      const existing = (snap.data()?.hard_requirements_met ?? {}) as Record<string, unknown>;

      const next: Record<(typeof HARD_REQUIREMENT_KEYS)[number], boolean> = {
        has_profile_ref: Boolean(existing.has_profile_ref),
        has_canonicality_mode: Boolean(existing.has_canonicality_mode),
        has_character_name: Boolean(existing.has_character_name),
        has_character_concept: Boolean(existing.has_character_concept),
        has_starting_situation: Boolean(existing.has_starting_situation),
      };
      if (spec.hardRequirementKey) {
        next[spec.hardRequirementKey] = true;
      }

      const update: Record<string, unknown> = {
        ...spec.toUpdate(validated),
        hard_requirements_met: next,
        updatedAt: FieldValue.serverTimestamp(),
      };
      tx.set(ref, update, { merge: true });
      return next;
    });

    return {
      field: input.field,
      committed: true as const,
      hard_requirements_met: hardRequirementsMet,
    };
  },
});
