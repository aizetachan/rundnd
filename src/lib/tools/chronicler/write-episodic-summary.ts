import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Populate the `summary` field on a just-completed turn doc. Chronicler
 * calls this once per turn with a tight 1–3 sentence distillation of
 * what happened — the handle KA uses during working-memory recall when
 * the full narrative is too big to fit.
 *
 * Idempotent: safe to re-run on a turn whose summary already exists
 * (overwrites). FIFO-per-campaign ordering in 7.4 ensures Chronicler
 * runs once per turn in turn-number order.
 *
 * Implementation: turn docs use autogen ids, so we resolve the doc by
 * querying `turnNumber == input.turn_number` within the campaign's
 * `turns` subcollection.
 */
const InputSchema = z.object({
  turn_number: z.number().int().positive(),
  summary: z.string().min(1),
});

const OutputSchema = z.object({
  turn_number: z.number().int().positive(),
  updated: z.boolean(),
});

export const writeEpisodicSummaryTool = registerTool({
  name: "write_episodic_summary",
  description:
    "Populate the 1–3 sentence summary for a completed turn. Overwrites existing summary if present.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("write_episodic_summary: ctx.firestore not provided");
    const turnsCol = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.turns);
    const snap = await turnsCol.where("turnNumber", "==", input.turn_number).limit(1).get();
    const doc = snap.docs[0];
    if (!doc) {
      throw new Error(`write_episodic_summary: no turn row found for turn ${input.turn_number}`);
    }
    await doc.ref.set({ summary: input.summary }, { merge: true });
    return { turn_number: input.turn_number, updated: true };
  },
});
