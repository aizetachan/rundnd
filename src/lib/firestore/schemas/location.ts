import { z } from "zod";

/**
 * `campaigns/{campaignId}/locations/{locationId}` — location catalog +
 * scene details. Details is opaque jsonb-equivalent; the consumer shape
 * lives in the location-related tools.
 */
export const FirestoreLocation = z.object({
  id: z.string(),
  campaignId: z.string(),
  name: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
  firstSeenTurn: z.number().int().nonnegative(),
  lastSeenTurn: z.number().int().nonnegative(),
  createdAt: z.date(),
});
export type FirestoreLocation = z.infer<typeof FirestoreLocation>;
