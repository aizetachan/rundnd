import { z } from "zod";

/**
 * `campaigns/{campaignId}/semanticMemories/{memoryId}` — distilled
 * cross-turn facts. `embedding` stays null until M4 backfills.
 */
export const FirestoreSemanticMemory = z.object({
  id: z.string(),
  campaignId: z.string(),
  category: z.string(),
  content: z.string(),
  heat: z.number().int().min(0).max(100).default(100),
  flags: z.record(z.string(), z.unknown()).default({}),
  turnNumber: z.number().int().nonnegative(),
  embedding: z.unknown().nullable().optional(),
  createdAt: z.date(),
});
export type FirestoreSemanticMemory = z.infer<typeof FirestoreSemanticMemory>;
