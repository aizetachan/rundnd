import { z } from "zod";

/**
 * `campaigns/{campaignId}/relationshipEvents/{eventId}` — append-only
 * milestone log written by RelationshipAnalyzer.
 */
export const FirestoreRelationshipEvent = z.object({
  id: z.string(),
  campaignId: z.string(),
  npcId: z.string(),
  milestoneType: z.string(),
  evidence: z.string(),
  turnNumber: z.number().int().nonnegative(),
  createdAt: z.date(),
});
export type FirestoreRelationshipEvent = z.infer<typeof FirestoreRelationshipEvent>;
