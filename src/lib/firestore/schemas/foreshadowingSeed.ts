import { z } from "zod";

export const ForeshadowingStatus = z.enum([
  "PLANTED",
  "GROWING",
  "CALLBACK",
  "RESOLVED",
  "ABANDONED",
  "OVERDUE",
]);
export type ForeshadowingStatus = z.infer<typeof ForeshadowingStatus>;

/**
 * `campaigns/{campaignId}/foreshadowingSeeds/{seedId}` — Chronicler
 * plants candidates; Director ratifies into real seeds.
 */
export const FirestoreForeshadowingSeed = z.object({
  id: z.string(),
  campaignId: z.string(),
  name: z.string(),
  description: z.string(),
  status: ForeshadowingStatus.default("PLANTED"),
  payoffWindowMin: z.number().int().nonnegative(),
  payoffWindowMax: z.number().int().nonnegative(),
  dependsOn: z.array(z.string()).default([]),
  conflictsWith: z.array(z.string()).default([]),
  plantedTurn: z.number().int().nonnegative(),
  resolvedTurn: z.number().int().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type FirestoreForeshadowingSeed = z.infer<typeof FirestoreForeshadowingSeed>;
