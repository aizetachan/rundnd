import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Ratify a Chronicler-planted candidate into a Director-sanctioned seed.
 * Transition: PLANTED → GROWING. Called by Director during session-
 * boundary reviews when a PLANTED candidate is worth tracking as part
 * of the active arc's causal graph. Fails if the seed isn't currently
 * PLANTED (idempotent-ish: double-ratify surfaces as error).
 *
 * Director landing is post-M1; we ship the tool now because plan §7.2
 * enumerates it as a 7.2 deliverable. The write path is exercised in
 * this commit; the orchestrator that calls it lands later.
 *
 * Implementation: runs in a transaction so the PLANTED→GROWING guard
 * is race-free against concurrent ratify calls.
 */
const InputSchema = z.object({
  seed_id: z.string().uuid(),
});

const OutputSchema = z.object({
  seed_id: z.string().min(1),
  status: z.literal("GROWING"),
});

export const ratifyForeshadowingSeedTool = registerTool({
  name: "ratify_foreshadowing_seed",
  description:
    "Ratify a PLANTED foreshadowing seed into GROWING status — Director session-boundary review. Fails if the seed isn't currently PLANTED.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("ratify_foreshadowing_seed: ctx.firestore not provided");
    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.foreshadowingSeeds)
      .doc(input.seed_id);

    return await ctx.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(
          `ratify_foreshadowing_seed: no PLANTED seed found for id ${input.seed_id} (may already be ratified, resolved, or belong to another campaign)`,
        );
      }
      const data = snap.data() ?? {};
      if (data.status !== "PLANTED") {
        throw new Error(
          `ratify_foreshadowing_seed: no PLANTED seed found for id ${input.seed_id} (may already be ratified, resolved, or belong to another campaign)`,
        );
      }
      tx.set(
        ref,
        { status: "GROWING", updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return { seed_id: input.seed_id, status: "GROWING" as const };
    });
  },
});
