import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Plant a foreshadowing seed with status PLANTED. Chronicler calls this
 * post-turn when KA's narration contains an element that should pay off
 * later — a secret name dropped, an unexplained artifact, a hesitation
 * that hinted at backstory. Director's session-boundary review (later
 * milestone) ratifies PLANTED → GROWING and eventually marks them
 * RESOLVED or ABANDONED via `resolve_seed`.
 *
 * KA has its own `plant_foreshadowing_seed` entrypoint for seeds it
 * plants deliberately mid-scene. Both write to the same collection with
 * the same PLANTED status — two call sites, one artifact. The
 * "candidate" framing signals: Chronicler spotted this retrospectively,
 * not pre-planned.
 */
const InputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  payoff_window_min: z.number().int().min(1),
  payoff_window_max: z.number().int().min(1),
  depends_on: z.array(z.string().uuid()).default([]),
  conflicts_with: z.array(z.string().uuid()).default([]),
  planted_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().min(1),
  status: z.literal("PLANTED"),
});

export const plantForeshadowingCandidateTool = registerTool({
  name: "plant_foreshadowing_candidate",
  description:
    "Retrospectively plant a foreshadowing seed Chronicler spotted in KA's narration. Status PLANTED; Director's session-boundary review may ratify later.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("plant_foreshadowing_candidate: ctx.firestore not provided");
    const ref = await ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.foreshadowingSeeds)
      .add({
        campaignId: ctx.campaignId,
        name: input.name,
        description: input.description,
        status: "PLANTED",
        payoffWindowMin: input.payoff_window_min,
        payoffWindowMax: input.payoff_window_max,
        dependsOn: input.depends_on,
        conflictsWith: input.conflicts_with,
        plantedTurn: input.planted_turn,
        resolvedTurn: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    return { id: ref.id, status: "PLANTED" as const };
  },
});
