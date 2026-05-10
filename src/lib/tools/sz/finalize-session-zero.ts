import { CAMPAIGN_SUB, COL, SESSION_ZERO_DOC_ID } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Conductor signals that Session Zero has gathered enough to hand off.
 * Validates `hard_requirements_met` (every flag true), transitions
 * `phase` from `in_progress` to `ready_for_handoff`, and stamps
 * `handoff_started_at`. The HandoffCompiler agent (sub 4) picks up
 * docs in this phase and emits the OpeningStatePackage.
 *
 * Idempotent: a second call when the doc is already in
 * `ready_for_handoff` is a no-op (no error). The conductor may call
 * twice if the SDK retries — we never want to fail a turn over a
 * harmless re-finalize.
 *
 * Hard-requirements gate is enforced in the transaction. Bypass would
 * require an authorized re-write of the SZ doc; the conductor itself
 * can't sneak past it just by calling this tool.
 */
const InputSchema = z.object({
  /**
   * One-paragraph summary of what the conductor + player built. This
   * lives on the SZ doc and seeds HandoffCompiler's context. Not the
   * final authoritative summary — HandoffCompiler may rewrite — but
   * the conductor's last word on the conversation.
   */
  rationale: z.string().min(1),
});

const OutputSchema = z.object({
  ok: z.literal(true),
  phase: z.enum(["ready_for_handoff"]),
  /** True when this call actually transitioned phase; false if it was already finalized. */
  transitioned: z.boolean(),
});

export const finalizeSessionZeroTool = registerTool({
  name: "finalize_session_zero",
  description:
    "Signal that Session Zero is ready for handoff. Validates all hard requirements are met. Transitions phase to ready_for_handoff. Idempotent — safe to retry. Call only after every hard requirement is true (check the latest commit_field output).",
  layer: "session_zero",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) {
      throw new Error("finalize_session_zero: ctx.firestore not provided");
    }
    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.sessionZero)
      .doc(SESSION_ZERO_DOC_ID);

    return await ctx.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(
          "finalize_session_zero: no SZ doc for this campaign — sub 3 / sub 6 should create it before the conductor runs",
        );
      }
      const data = snap.data() ?? {};
      const phase = data.phase as string | undefined;
      const hard = (data.hard_requirements_met ?? {}) as Record<string, unknown>;

      // Idempotent: already finalized → no-op.
      if (
        phase === "ready_for_handoff" ||
        phase === "handoff_in_progress" ||
        phase === "complete"
      ) {
        return {
          ok: true as const,
          phase: "ready_for_handoff" as const,
          transitioned: false,
        };
      }

      const missing: string[] = [];
      for (const key of [
        "has_profile_ref",
        "has_canonicality_mode",
        "has_character_name",
        "has_character_concept",
        "has_starting_situation",
      ]) {
        if (!hard[key]) missing.push(key);
      }
      if (missing.length > 0) {
        throw new Error(
          `finalize_session_zero: cannot transition — hard requirements not met: ${missing.join(", ")}`,
        );
      }

      tx.set(
        ref,
        {
          phase: "ready_for_handoff",
          handoff_started_at: FieldValue.serverTimestamp(),
          blocking_issues: [],
          rolling_summary: input.rationale,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return {
        ok: true as const,
        phase: "ready_for_handoff" as const,
        transitioned: true,
      };
    });
  },
});
