import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

const ACTIVE_STATUSES = new Set(["PLANTED", "GROWING", "CALLBACK"]);

/**
 * Retire an active foreshadowing seed as ABANDONED — plot moved past it,
 * character who'd pay it off died, Director's session review decided
 * not to pursue. Accepts PLANTED, GROWING, or CALLBACK seeds; rejects
 * already-RESOLVED / ABANDONED / OVERDUE (the state machine's terminal
 * states).
 *
 * Distinct from `resolve_seed` — which covers both RESOLVED (payoff)
 * and ABANDONED (skipped). `retire_foreshadowing_seed` is the explicit
 * ABANDONED entry point Director uses during session reviews.
 *
 * Implementation: runs in a transaction so the active-status guard is
 * race-free against concurrent retires/resolves.
 */
const InputSchema = z.object({
  seed_id: z.string().uuid(),
  reason: z.string().optional().describe("Short justification; not persisted at M1 (logged only)"),
});

const OutputSchema = z.object({
  seed_id: z.string().min(1),
  status: z.literal("ABANDONED"),
});

export const retireForeshadowingSeedTool = registerTool({
  name: "retire_foreshadowing_seed",
  description:
    "Mark an active foreshadowing seed ABANDONED. Fails if the seed is already terminal (RESOLVED, ABANDONED, OVERDUE).",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("retire_foreshadowing_seed: ctx.firestore not provided");
    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.foreshadowingSeeds)
      .doc(input.seed_id);

    return await ctx.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(
          `retire_foreshadowing_seed: no active seed found for id ${input.seed_id} (may already be terminal or belong to another campaign)`,
        );
      }
      const data = snap.data() ?? {};
      const status = typeof data.status === "string" ? data.status : "";
      if (!ACTIVE_STATUSES.has(status)) {
        throw new Error(
          `retire_foreshadowing_seed: no active seed found for id ${input.seed_id} (may already be terminal or belong to another campaign)`,
        );
      }
      tx.set(
        ref,
        { status: "ABANDONED", updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return { seed_id: input.seed_id, status: "ABANDONED" as const };
    });
  },
});
