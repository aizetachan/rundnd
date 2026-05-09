import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { ContextBlockType } from "@/lib/types/entities";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Fetch a single context block by (block_type, entity_name). Rare in
 * practice — KA reads the full active-block bundle at session start via
 * Block 2 rendering, so this tool is for mid-scene "I need the full
 * picture on this NPC right now" moments.
 *
 * Returns null if no block exists (fresh campaigns before Chronicler
 * has generated anything, or entities KA is meeting for the first
 * time). Graceful absent.
 */
const InputSchema = z.object({
  block_type: ContextBlockType,
  entity_name: z.string().min(1),
});

const OutputSchema = z
  .object({
    content: z.string(),
    continuity_checklist: z.record(z.string(), z.unknown()),
    version: z.number().int(),
    status: z.enum(["active", "closed", "archived"]),
    last_updated_turn: z.number().int(),
  })
  .nullable();

export const getContextBlockTool = registerTool({
  name: "get_context_block",
  description:
    "Fetch the living context block for a specific entity (arc | thread | quest | npc | faction | location) by name. Returns null if no block exists yet. Use when you need the full picture on this entity mid-scene; the session-start bundle already includes active blocks.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) return null;
    const snap = await ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.contextBlocks)
      .where("blockType", "==", input.block_type)
      .where("entityName", "==", input.entity_name)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    if (!doc) return null;
    const row = doc.data();
    return {
      content: row.content,
      continuity_checklist: (row.continuityChecklist ?? {}) as Record<string, unknown>,
      version: row.version,
      status: row.status,
      last_updated_turn: row.lastUpdatedTurn,
    };
  },
});
