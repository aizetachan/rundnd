import { z } from "zod";

/**
 * `campaigns/{campaignId}/characters/{characterId}` — the player's PC for
 * a campaign. One per campaign (M1 invariant — enforced in the seed/create
 * paths since Firestore can't model UNIQUE constraints).
 *
 * `sheet` is the IP-dependent shape: stats, abilities, inventory,
 * stat_mapping, current_state. The `get_character_sheet` tool in
 * src/lib/tools/entities/ defines the consumer-side parse.
 */
export const FirestoreCharacter = z.object({
  id: z.string(),
  campaignId: z.string(), // denormalized for collection-group queries / debugging
  name: z.string(),
  concept: z.string(),
  powerTier: z.string(),
  sheet: z.unknown(),
  createdAt: z.date(),
});
export type FirestoreCharacter = z.infer<typeof FirestoreCharacter>;
