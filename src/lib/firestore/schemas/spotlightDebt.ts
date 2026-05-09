import { z } from "zod";

/**
 * `campaigns/{campaignId}/spotlightDebt/{npcId}` — uses npcId as the
 * doc id so the (campaign, npc) uniqueness invariant is structural,
 * mirroring the SQL UNIQUE constraint without a separate index.
 *
 * Atomic increment with FieldValue.increment(delta) gives the same
 * ON CONFLICT DO UPDATE semantics as Postgres.
 */
export const FirestoreSpotlightDebt = z.object({
  id: z.string(), // == npcId
  campaignId: z.string(),
  npcId: z.string(),
  debt: z.number().int().default(0),
  updatedAtTurn: z.number().int().nonnegative(),
});
export type FirestoreSpotlightDebt = z.infer<typeof FirestoreSpotlightDebt>;
