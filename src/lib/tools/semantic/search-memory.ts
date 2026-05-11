import { embedText, isEmbedderConfigured } from "@/lib/embeddings";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { boostHeatOnAccess } from "@/lib/memory/decay";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Semantic search over distilled cross-turn memories. M4 sub 2 wires
 * the runtime: queries embed → Firestore `findNearest` cosine top-k →
 * STATIC_BOOST + heat boost on access. MemoryRanker (further rerank)
 * is a separate KA consultant that callers can layer on top.
 *
 * Degrades gracefully when the embedder isn't configured or the query
 * embedding call fails — returns `[]` with the same shape KA expects
 * for "no relevant memory yet."
 */
const InputSchema = z.object({
  // Either a single `query` OR an array of `queries` — caller chooses.
  // Multi-query decomposition (v3-parity Phase 7 — MINOR #19) lets KA
  // fan out 2-3 orthogonal queries ("action", "situation", "entity") and
  // merge results server-side with dedup.
  query: z.string().min(1).optional(),
  queries: z
    .array(z.string().min(1))
    .max(5)
    .optional()
    .describe(
      "Fan-out multi-query decomposition. Prefer 2-3 orthogonal queries over one dense query for complex scenes.",
    ),
  k: z.number().int().min(1).max(20).default(5),
  categories: z
    .array(
      z.enum([
        "core",
        "session_zero",
        "session_zero_voice",
        "relationship",
        "consequence",
        "fact",
        "npc_interaction",
        "location",
        "narrative_beat",
        "quest",
        "world_state",
        "event",
        "npc_state",
        "character_state",
        "episode",
      ]),
    )
    .optional()
    .describe("Restrict to specific memory categories (§9.1)"),
  min_heat: z.number().min(0).max(100).default(0),
});

const OutputSchema = z.object({
  memories: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      fragment: z.string().nullable().describe("Storyboarded prose fragment for voice recall"),
      category: z.string(),
      heat: z.number(),
      relevance: z.number(),
      created_turn: z.number(),
    }),
  ),
});

/**
 * Static boost applied to specific categories before final ranking.
 * session_zero + plot_critical facts shouldn't be ranked purely on
 * cosine similarity — they're load-bearing for the campaign and need
 * floor visibility. Episode-level summaries get a smaller bump so they
 * surface in recall when relevant.
 */
const STATIC_BOOST: Record<string, number> = {
  session_zero: 0.3,
  session_zero_voice: 0.3,
  core: 0.3,
  episode: 0.15,
};

interface Candidate {
  id: string;
  content: string;
  fragment: string | null;
  category: string;
  heat: number;
  /** Distance from cosine query — lower is better; 0 = identical. */
  distance: number;
  created_turn: number;
}

async function nearestForQuery(
  firestore: Firestore,
  campaignId: string,
  vector: number[],
  k: number,
): Promise<Candidate[]> {
  const collection = firestore
    .collection(COL.campaigns)
    .doc(campaignId)
    .collection(CAMPAIGN_SUB.semanticMemories);
  // findNearest pulls k * 2 to leave headroom for post-filter on
  // category + min_heat before truncating to k.
  const vq = collection.findNearest({
    vectorField: "embedding",
    queryVector: vector,
    limit: Math.min(k * 2, 40),
    distanceMeasure: "COSINE",
    distanceResultField: "_distance",
  });
  const snap = await vq.get();
  const out: Candidate[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    out.push({
      id: doc.id,
      content: typeof d.content === "string" ? d.content : "",
      fragment: typeof d.fragment === "string" ? d.fragment : null,
      category: typeof d.category === "string" ? d.category : "",
      heat: typeof d.heat === "number" ? d.heat : 0,
      distance: typeof d._distance === "number" ? d._distance : 1,
      created_turn: typeof d.turnNumber === "number" ? d.turnNumber : 0,
    });
  }
  return out;
}

export const searchMemoryTool = registerTool({
  name: "search_memory",
  description:
    "Semantic search over distilled cross-turn memory. Returns ranked facts + their storyboarded prose fragments.",
  layer: "semantic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!input.query && (!input.queries || input.queries.length === 0)) {
      throw new Error(
        "search_memory: must supply either `query` (single) or `queries` (array). Both absent.",
      );
    }
    if (!ctx.firestore) throw new Error("search_memory: ctx.firestore not provided");
    if (!isEmbedderConfigured()) {
      // Without an embedder we have no query vector — the read path
      // can't ship. Empty array preserves KA's "no relevant memory"
      // contract.
      return { memories: [] };
    }

    const queryStrings = input.queries ?? (input.query ? [input.query] : []);

    // Embed each query. Failures collapse to skipping that query —
    // partial fan-out is better than failing the whole call.
    const queryVectors: number[][] = [];
    for (const q of queryStrings) {
      try {
        const result = await embedText(q);
        queryVectors.push(result.vector);
      } catch (err) {
        console.warn("search_memory: query embed failed; skipping", {
          campaignId: ctx.campaignId,
          query: q.slice(0, 80),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (queryVectors.length === 0) return { memories: [] };

    // Fan out findNearest per query. Merge by doc id; for duplicates
    // keep the SMALLEST distance (highest similarity).
    const byId = new Map<string, Candidate>();
    for (const vec of queryVectors) {
      let near: Candidate[];
      try {
        near = await nearestForQuery(ctx.firestore, ctx.campaignId, vec, input.k);
      } catch (err) {
        console.warn("search_memory: findNearest failed for one query; continuing", {
          campaignId: ctx.campaignId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      for (const cand of near) {
        const existing = byId.get(cand.id);
        if (!existing || cand.distance < existing.distance) byId.set(cand.id, cand);
      }
    }

    // Apply filters + static boost + final ranking.
    const categoryFilter =
      input.categories && input.categories.length > 0
        ? new Set(input.categories as readonly string[])
        : null;
    const ranked = Array.from(byId.values())
      .filter((c) => c.heat >= input.min_heat)
      .filter((c) => !categoryFilter || categoryFilter.has(c.category))
      .map((c) => {
        // Cosine distance is in [0, 2]; relevance = 1 - (distance / 2)
        // gives a [0, 1] similarity score we can boost on top of.
        const similarity = Math.max(0, Math.min(1, 1 - c.distance / 2));
        const staticBoost = STATIC_BOOST[c.category] ?? 0;
        // Heat factor: 100 = no penalty, 0 = halve the relevance.
        const heatFactor = 0.5 + (c.heat / 100) * 0.5;
        const relevance = (similarity + staticBoost) * heatFactor;
        return { ...c, relevance };
      })
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, input.k);

    // Fire-and-forget heat boost on access. Don't await — the tool's
    // caller (KA) doesn't need to wait on the write, and a failure
    // here shouldn't fail the read.
    for (const c of ranked) {
      void boostHeatOnAccess(ctx.firestore, ctx.campaignId, c.id, c.category).catch(() => {});
    }

    return {
      memories: ranked.map((c) => ({
        id: c.id,
        content: c.content,
        fragment: c.fragment,
        category: c.category,
        heat: c.heat,
        relevance: Number(c.relevance.toFixed(4)),
        created_turn: c.created_turn,
      })),
    };
  },
});
