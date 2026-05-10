import { CanonicalityMode } from "@/lib/types/session-zero";
import { z } from "zod";
import { registerTool } from "../registry";
import { appendConductorToolCall } from "./_history";

/**
 * Surface the four canonicality modes to the player and explain which
 * the conductor recommends. Like `propose_character_option`, this tool
 * does NOT commit `canonicality_mode` to the SZ state — the player
 * confirms in-conversation, then the conductor calls
 * `commit_field({ field: "canonicality_mode", value: ... })`.
 *
 * Modes (per ROADMAP §10.2):
 *   - `full_cast`        — keep the entire canonical ensemble; player is a new addition
 *   - `replaced_protagonist` — player takes the protagonist slot; ensemble stays
 *   - `npcs_only`        — keep the world but no canon characters present
 *   - `inspired`         — same world flavor, all-original cast (and possibly story)
 *
 * The conductor calls this after the profile is pinned but before
 * character options — canonicality changes the cast available to the
 * player, which changes which character archetypes make sense.
 */
const ModeOption = z.object({
  mode: CanonicalityMode,
  /** One-sentence pitch for what this mode means in this profile's world. */
  pitch: z.string().min(1),
});

const InputSchema = z.object({
  /**
   * All four modes, surfaced in the order the conductor wants the
   * player to consider them. The recommended mode goes first.
   */
  options: z.array(ModeOption).min(2).max(4),
  /** Conductor's pick. Must appear in `options.mode`. */
  recommended: CanonicalityMode,
  /** 1–2 sentences explaining the recommendation. */
  rationale: z.string().min(1),
});

const OutputSchema = z.object({
  ok: z.literal(true),
  recommended: CanonicalityMode,
});

export const proposeCanonicalityModeTool = registerTool({
  name: "propose_canonicality_mode",
  description:
    "Surface canonicality modes (full_cast / replaced_protagonist / npcs_only / inspired) to the player with a recommendation. Does NOT commit canonicality_mode — call commit_field after the player picks. Call once profile is pinned but before character options.",
  layer: "session_zero",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) {
      throw new Error("propose_canonicality_mode: ctx.firestore not provided");
    }
    const recommendedInOptions = input.options.some((o) => o.mode === input.recommended);
    if (!recommendedInOptions) {
      throw new Error(
        `propose_canonicality_mode: recommended "${input.recommended}" not present in options`,
      );
    }
    const result = { ok: true as const, recommended: input.recommended };
    await appendConductorToolCall({
      firestore: ctx.firestore,
      campaignId: ctx.campaignId,
      toolName: "propose_canonicality_mode",
      args: input,
      result,
    });
    return result;
  },
});
