import { z } from "zod";

/**
 * `campaigns/{campaignId}/npcs/{npcId}` — NPC catalog. Mirrors the prior
 * Postgres shape so the existing tool consumers don't need to relearn
 * the field set.
 */
export const FirestoreNpc = z.object({
  id: z.string(),
  campaignId: z.string(),
  name: z.string(),
  role: z.string().default("acquaintance"),
  personality: z.string().default(""),
  goals: z.array(z.string()).default([]),
  secrets: z.array(z.string()).default([]),
  faction: z.string().nullable().optional(),
  visualTags: z.array(z.string()).default([]),
  knowledgeTopics: z.record(z.string(), z.unknown()).default({}),
  powerTier: z.string().default("T10"),
  ensembleArchetype: z.string().nullable().optional(),
  isTransient: z.boolean().default(false),
  firstSeenTurn: z.number().int().nonnegative(),
  lastSeenTurn: z.number().int().nonnegative(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type FirestoreNpc = z.infer<typeof FirestoreNpc>;
