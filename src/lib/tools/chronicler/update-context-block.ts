import { generateContextBlock } from "@/lib/agents";
import { CAMPAIGN_SUB, COL, safeNameId } from "@/lib/firestore";
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
 *   1. Resolve the deterministic doc id from (block_type, entity_name).
 *      Two concurrent writers converge on the same doc id rather than
 *      racing to create version=1 twice.
 *   2. Read the existing block (if any). Use its content as
 *      prior_version for the generator.
 *   3. Gather structured entity_data from the appropriate catalog
 *      subcollection (npcs for "npc"; other kinds backfill as those
 *      catalogs mature).
 *   4. Invoke generateContextBlock — slow LLM call, kept OUTSIDE the
 *      transaction so write contention doesn't pin LLM latency.
 *   5. Inside a runTransaction: re-read the doc, bump version, write.
 *     The atomic read-then-write closes the race the doc-id alone
 *     can't (two writers seeing version=1, both writing version=2).
 *
 * This is the sole write path for context_blocks at M1. No other tool
 * should insert directly — centralizing through the generator keeps
 * content quality consistent.
 *
 * Phase 3C of v3-audit closure (docs/plans/v3-audit-closure.md §3.3).
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

    // Deterministic doc id from (block_type, entity_name) — two writers
    // for the same entity converge on this doc instead of racing.
    const docId = safeNameId(`${input.block_type}__${input.entity_name}`);
    const blockRef = blocksCol.doc(docId);

    const existingSnap = await blockRef.get();
    const existingData = existingSnap.exists ? existingSnap.data() : null;

    // Structured entity data by block_type. NPC blocks pull from the
    // campaign's npcs subcollection; other kinds land with empty
    // entityData at M1.
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

    // Invoke the generator OUTSIDE the transaction — LLM latency would
    // pin the transaction open and starve other writers.
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

    // Atomic version bump: re-read inside the transaction to catch any
    // concurrent write that landed while the LLM was running.
    const result = await ctx.firestore.runTransaction(async (tx) => {
      const txSnap = await tx.get(blockRef);
      if (txSnap.exists) {
        const data = txSnap.data() ?? {};
        const nextVersion = (data.version as number) + 1;
        tx.set(
          blockRef,
          {
            content: generated.content,
            continuityChecklist: generated.continuity_checklist,
            version: nextVersion,
            lastUpdatedTurn: input.turn_number,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return { version: nextVersion, created: false };
      }
      tx.set(blockRef, {
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
      return { version: 1, created: true };
    });

    return { id: docId, version: result.version, created: result.created };
  },
});
