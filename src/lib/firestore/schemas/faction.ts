import { z } from "zod";

/**
 * `campaigns/{campaignId}/factions/{factionId}` — faction catalog.
 */
export const FirestoreFaction = z.object({
  id: z.string(),
  campaignId: z.string(),
  name: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.date(),
});
export type FirestoreFaction = z.infer<typeof FirestoreFaction>;
