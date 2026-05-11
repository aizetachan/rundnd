import { embedText, isEmbedderConfigured } from "@/lib/embeddings";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Write a distilled cross-turn fact to semantic memory (§9.1). Chronicler
 * calls this for facts that may matter later — "Spike owes Jet gas money",
 * "Vicious knows Julia's hiding on Callisto". Heat 0–100; KA's
 * `search_memory` ranks by relevance * heat * decay-by-category.
 *
 * M4 sub 1: when `AIDM_EMBEDDING_PROVIDER` is configured (default
 * `"gemini"`), populate the `embedding` field via the dispatcher in
 * `src/lib/embeddings`. Embedder failure logs + falls back to
 * `embedding: null` so writes never block on Gemini availability.
 * Read path (M4 sub 2) consumes both — null rows degrade to
 * category + heat ranking.
 */
const InputSchema = z.object({
  category: z
    .string()
    .min(1)
    .describe(
      "§9.1 category: relationship | location_fact | ability_fact | lore | npc_interaction | world_state | etc. Free-form at M1; Chronicler may nominate new categories.",
    ),
  content: z.string().min(1).describe("Distilled fact in 1–3 sentences"),
  heat: z.number().int().min(0).max(100).default(100),
  turn_number: z.number().int().positive(),
  /**
   * Decay-modifying flags (§9.1 physics). plot_critical bypasses decay
   * entirely; milestone_relationship floors at 40. Use sparingly —
   * these override the category's decay curve.
   */
  flags: z
    .object({
      plot_critical: z.boolean().optional(),
      milestone_relationship: z.boolean().optional(),
      boost_priority: z.number().optional(),
    })
    .optional(),
});

const OutputSchema = z.object({
  id: z.string().min(1),
});

export const writeSemanticMemoryTool = registerTool({
  name: "write_semantic_memory",
  description:
    "Write a distilled cross-turn fact to semantic memory. Use heat 70+ for facts central to the story, 30–60 for supporting details, <30 for context that may decay.",
  layer: "semantic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("write_semantic_memory: ctx.firestore not provided");

    // Best-effort embedding. If the env disables embedding or the
    // embedder call fails, we persist with `embedding: null` so the
    // write never blocks Chronicler.
    let embedding: number[] | null = null;
    if (isEmbedderConfigured()) {
      try {
        const result = await embedText(input.content);
        embedding = result.vector;
      } catch (err) {
        // Log via console (no logger threaded through ctx here);
        // future log infrastructure can pick this up if it matters.
        console.warn("write_semantic_memory: embed failed, persisting with embedding=null", {
          campaignId: ctx.campaignId,
          category: input.category,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const ref = await ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.semanticMemories)
      .add({
        campaignId: ctx.campaignId,
        category: input.category,
        content: input.content,
        heat: input.heat,
        flags: input.flags ?? {},
        turnNumber: input.turn_number,
        embedding,
        createdAt: FieldValue.serverTimestamp(),
      });
    return { id: ref.id };
  },
});
