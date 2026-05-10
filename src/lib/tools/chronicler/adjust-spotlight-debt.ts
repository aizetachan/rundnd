import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";
import { assertNpcBelongsToCampaign } from "./_npc-guard";

/**
 * Adjust an NPC's spotlight debt by `delta`. Negative debt = NPC is
 * underexposed (Director should pull them in); positive = recently
 * on-screen (Director should rest them). Director consults this when
 * choosing arc_mode (ensemble_arc vs main_arc). One row per (campaign,
 * npc); upserted with `debt = debt + delta`.
 *
 * Chronicler calls per-turn: + for NPCs who were in the scene, – for
 * NPCs who sat out. Magnitude tunable; M1 default is ±1 per turn per
 * NPC with Director-level nudges allowed.
 *
 * Implementation: doc id = npcId, atomic increment via
 * FieldValue.increment(delta) with set-merge. Same atomic semantics as
 * Postgres ON CONFLICT DO UPDATE; first call seeds debt=delta, later
 * calls increment.
 */
const InputSchema = z.object({
  npc_id: z.string().min(1),
  delta: z.number().int(),
  updated_at_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  npc_id: z.string().min(1),
  debt: z.number().int(),
});

export const adjustSpotlightDebtTool = registerTool({
  name: "adjust_spotlight_debt",
  description:
    "Adjust spotlight debt for an NPC by a signed delta. Positive = recently on-screen; negative = underexposed. Upserts on (campaign, npc).",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("adjust_spotlight_debt: ctx.firestore not provided");
    await assertNpcBelongsToCampaign(ctx, input.npc_id, "adjust_spotlight_debt");

    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.spotlightDebt)
      .doc(input.npc_id);

    await ref.set(
      {
        campaignId: ctx.campaignId,
        npcId: input.npc_id,
        debt: FieldValue.increment(input.delta),
        updatedAtTurn: input.updated_at_turn,
      },
      { merge: true },
    );

    // Read-after-write to return the post-increment value. Acceptable —
    // adjust_spotlight_debt is a low-frequency post-turn writer, not a
    // hot path.
    const snap = await ref.get();
    const data = snap.data() ?? {};
    const debt = typeof data.debt === "number" ? data.debt : 0;
    return { npc_id: input.npc_id, debt };
  },
});
