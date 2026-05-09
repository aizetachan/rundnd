import { z } from "zod";

/**
 * `campaigns/{campaignId}/contextBlocks/{blockId}` — per-entity living
 * prose summaries that survive across sessions. Each doc holds the
 * "current document" for one entity (an arc's state, an NPC's bio, a
 * faction's posture).
 *
 * `embedding` stays optional/nullable until M4 backfills.
 */
export const ContextBlockType = z.enum(["arc", "thread", "quest", "npc", "faction", "location"]);
export type ContextBlockType = z.infer<typeof ContextBlockType>;

export const ContextBlockStatus = z.enum(["active", "closed", "archived"]);
export type ContextBlockStatus = z.infer<typeof ContextBlockStatus>;

export const FirestoreContextBlock = z.object({
  id: z.string(),
  campaignId: z.string(),
  blockType: ContextBlockType,
  entityId: z.string().nullable().optional(),
  entityName: z.string(),
  content: z.string(),
  continuityChecklist: z.record(z.string(), z.unknown()).default({}),
  status: ContextBlockStatus.default("active"),
  version: z.number().int().positive().default(1),
  firstTurn: z.number().int().nonnegative(),
  lastUpdatedTurn: z.number().int().nonnegative(),
  embedding: z.unknown().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type FirestoreContextBlock = z.infer<typeof FirestoreContextBlock>;
