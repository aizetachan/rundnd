import { generateContextBlock } from "@/lib/agents";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { anthropicFallbackConfig } from "@/lib/providers";
import { ContextBlockType } from "@/lib/types/entities";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Update (or create) a context block for a given entity. Chronicler
 * calls this when a material change to an entity's state warrants a
 * re-distillation — arc phase shift, relationship milestone,
 * significant revelation, new NPC becoming load-bearing.
 *
 * Flow:
 *   1. Check for an existing block (same campaign, block_type,
 *      entity_name). If present, treat its content as prior_version.
 *   2. Gather structured entity_data from the appropriate catalog
 *      subcollection (npcs for "npc", and other entity kinds backfill
 *      as those catalogs mature).
 *   3. Invoke generateContextBlock with the collected context.
 *   4. Upsert: existing → version+1; new → version=1.
 *
 * This is the sole write path for context_blocks at M1. No other tool
 * should insert directly — centralizing through the generator keeps
 * content quality consistent.
 *
 * Phase 3C of v3-audit closure (docs/plans/v3-audit-closure.md §3.3).
 *
 * Implementation: Firestore has no compound unique index on
 * (blockType, entityName). We resolve the existing doc with a
 * .where().where().limit(1) query and run the version-bump in a
 * transaction so two concurrent writers can't both create version=1
 * docs.
 */

const InputSchema = z.object({
  block_type: ContextBlockType,
  entity_name: z.string().min(1),
  turn_number: z.number().int().positive(),
  /**
   * Optional extra context Chronicler wants the generator to see —
   * recent turn summaries, related semantic memories, etc. Passed
   * through to the agent untouched.
   */
  related_turns: z.array(z.string()).optional(),
  related_memories: z.array(z.string()).optional(),
});

const OutputSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  created: z.boolean(),
});

export const updateContextBlockTool = registerTool({
  name: "update_context_block",
  description:
    "Regenerate (or first-time create) the living context block for an entity — arc / thread / quest / npc / faction / location. Fires the ContextBlockGenerator agent with the entity's structured data + related turn/memory context + the prior version (if present). Call when a material change warrants a re-distillation; the system keeps stable blocks by default.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("update_context_block: ctx.firestore not provided");

    const blocksCol = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.contextBlocks);

    // Locate the existing block (if any) for this (block_type, entity_name).
    const existingSnap = await blocksCol
      .where("blockType", "==", input.block_type)
      .where("entityName", "==", input.entity_name)
      .limit(1)
      .get();
    const existingDoc = existingSnap.docs[0] ?? null;
    const existingData = existingDoc?.data() ?? null;

    // Structured entity data by block_type. NPC blocks pull from the
    // campaign's npcs subcollection; other kinds land with empty
    // entityData at M1 (arc/quest/faction/location backfill lands as
    // those catalogs mature).
    let entityData: Record<string, unknown> = {};
    let entityId: string | null = null;
    if (input.block_type === "npc") {
      const npcSnap = await ctx.firestore
        .collection(COL.campaigns)
        .doc(ctx.campaignId)
        .collection(CAMPAIGN_SUB.npcs)
        .where("name", "==", input.entity_name)
        .limit(1)
        .get();
      const npcDoc = npcSnap.docs[0];
      if (npcDoc) {
        const npc = npcDoc.data();
        entityId = npcDoc.id;
        entityData = {
          role: npc.role,
          personality: npc.personality,
          goals: npc.goals,
          secrets: npc.secrets,
          faction: npc.faction,
          visualTags: npc.visualTags,
          knowledgeTopics: npc.knowledgeTopics,
          powerTier: npc.powerTier,
          ensembleArchetype: npc.ensembleArchetype,
          firstSeenTurn: npc.firstSeenTurn,
          lastSeenTurn: npc.lastSeenTurn,
        };
      }
    }

    // Invoke the generator. modelContext defaults to Anthropic fallback
    // — Chronicler passes its own via the wrapper when this tool is
    // called through its standard flow, but direct invocation (e.g.
    // from a manual admin script) gets a sane default.
    const generated = await generateContextBlock(
      {
        blockType: input.block_type,
        entityName: input.entity_name,
        entityData,
        relatedTurns: input.related_turns ?? [],
        relatedMemories: input.related_memories ?? [],
        priorVersion: existingData
          ? {
              content: existingData.content,
              continuity_checklist: (existingData.continuityChecklist ?? {}) as Record<
                string,
                unknown
              >,
              version: existingData.version as number,
            }
          : null,
      },
      { modelContext: anthropicFallbackConfig() },
    );

    if (existingDoc && existingData) {
      const nextVersion = (existingData.version as number) + 1;
      await existingDoc.ref.set(
        {
          content: generated.content,
          continuityChecklist: generated.continuity_checklist,
          version: nextVersion,
          lastUpdatedTurn: input.turn_number,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { id: existingDoc.id, version: nextVersion, created: false };
    }

    const newRef = await blocksCol.add({
      campaignId: ctx.campaignId,
      blockType: input.block_type,
      entityId,
      entityName: input.entity_name,
      content: generated.content,
      continuityChecklist: generated.continuity_checklist,
      status: "active",
      version: 1,
      firstTurn: input.turn_number,
      lastUpdatedTurn: input.turn_number,
      embedding: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { id: newRef.id, version: 1, created: true };
  },
});
