import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";
import { assertNpcBelongsToCampaign } from "./_npc-guard";

/**
 * Append a relationship milestone to the event log. Called by
 * RelationshipAnalyzer (Chronicler's thinking-tier consultant) when it
 * detects moments like first_trust, first_vulnerability, first_sacrifice.
 * Append-only — milestones never mutate once recorded; revisions come
 * as new events with different milestone types.
 *
 * Schema enforces milestone_type + evidence non-empty. The enum is
 * intentionally free-form at M1 so RelationshipAnalyzer can nominate new
 * types; M4+ may tighten to a closed enum once the taxonomy stabilizes.
 */
const InputSchema = z.object({
  npc_id: z.string().min(1),
  milestone_type: z.string().min(1),
  evidence: z.string().min(1),
  turn_number: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().min(1),
});

export const recordRelationshipEventTool = registerTool({
  name: "record_relationship_event",
  description:
    "Append a relationship milestone (first_trust, first_vulnerability, betrayal, etc.) to the event log. Evidence is a short prose ground for the milestone.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("record_relationship_event: ctx.firestore not provided");
    // Defense-in-depth: verify the npc lives under this campaign before
    // recording an event against it. Firestore has no FKs.
    await assertNpcBelongsToCampaign(ctx, input.npc_id, "record_relationship_event");

    const ref = await ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.relationshipEvents)
      .add({
        campaignId: ctx.campaignId,
        npcId: input.npc_id,
        milestoneType: input.milestone_type,
        evidence: input.evidence,
        turnNumber: input.turn_number,
        createdAt: FieldValue.serverTimestamp(),
      });
    return { id: ref.id };
  },
});
