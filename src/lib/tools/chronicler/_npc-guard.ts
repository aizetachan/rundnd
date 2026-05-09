import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import type { AidmToolContext } from "../types";

/**
 * Cross-campaign FK integrity guard. Firestore has no foreign keys, so a
 * hallucinated `npc_id` from another campaign would silently land under
 * the wrong subcollection without this pre-write check.
 *
 * `authorizeCampaignAccess` has already proven the caller owns
 * `ctx.campaignId`. We then read the NPC under that campaign's `npcs`
 * subcollection — if it doesn't exist there, the id is either bogus or
 * belongs to a different campaign. Either way, refuse.
 *
 * Cheap (single doc read by id), so every write tool that accepts an
 * `npc_id` calls this.
 */
export async function assertNpcBelongsToCampaign(
  ctx: Pick<AidmToolContext, "firestore" | "campaignId">,
  npcId: string,
  toolName: string,
): Promise<void> {
  if (!ctx.firestore) throw new Error(`${toolName}: ctx.firestore not provided`);
  const snap = await ctx.firestore
    .collection(COL.campaigns)
    .doc(ctx.campaignId)
    .collection(CAMPAIGN_SUB.npcs)
    .doc(npcId)
    .get();
  if (!snap.exists) {
    throw new Error(`${toolName}: npc_id ${npcId} not found in this campaign`);
  }
}
