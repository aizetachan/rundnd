import { CAMPAIGN_SUB, COL, safeNameId } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Spawn a transient NPC — scene-local flavor character unlikely to
 * recur. No portrait generation, filtered out of list_known_npcs by
 * default, no relationship-event tracking. The bartender, a guard on
 * the corner, a passing sailor.
 *
 * v3-parity Phase 6A of v3-audit closure. Original v4 had only
 * register_npc, which promoted every named flavor character to catalog —
 * reopening v3's catalog-inflation failure mode. Chronicler now chooses:
 * `register_npc` for recurring figures, `spawn_transient` for one-off
 * flavor.
 *
 * Implementation: writes to the same `npcs` subcollection as
 * register_npc with isTransient=true. Doc id = safeNameId(name) so a
 * later re-spawn (or upgrade via update_npc) lands on the same doc.
 * The reverse — demoting a catalog NPC to transient — isn't currently
 * supported; rare and ambiguous.
 */
const InputSchema = z.object({
  name: z.string().min(1),
  /** One-line description used for rendering in scene continuity but
   * not for persistent character memory. */
  description: z.string().default(""),
  turn_number: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().min(1),
  created: z.boolean(),
});

export const spawnTransientTool = registerTool({
  name: "spawn_transient",
  description:
    "Spawn a transient (flavor) NPC — scene-local, unlikely to recur, not added to the catalog. Use for named-once characters: the bartender, a passing sailor, a guard at the door. For named recurring figures use register_npc instead.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("spawn_transient: ctx.firestore not provided");
    const id = safeNameId(input.name);
    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.npcs)
      .doc(id);

    return await ctx.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        return { id, created: false };
      }
      tx.set(ref, {
        campaignId: ctx.campaignId,
        name: input.name,
        role: "transient",
        personality: input.description,
        goals: [],
        secrets: [],
        faction: null,
        visualTags: [],
        knowledgeTopics: {},
        powerTier: "T10",
        ensembleArchetype: null,
        isTransient: true,
        firstSeenTurn: input.turn_number,
        lastSeenTurn: input.turn_number,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { id, created: true };
    });
  },
});
