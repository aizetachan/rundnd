import { searchTurns } from "@/lib/algolia/turn-index";
import { isAlgoliaConfigured } from "@/lib/algolia/client";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import type { Query } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Keyword search over turn transcripts. Returns the turn numbers whose
 * narrative prose matches the query, with a short excerpt for
 * disambiguation. KA uses this to reach back for specific prior scenes —
 * "the fight with Vicious" — and then pulls the full prose via
 * `get_turn_narrative`.
 *
 * Two paths:
 *   - **Algolia** (primary): real full-text search via the Algolia
 *     client. Stemming, ranking, snippet generation. Replaces the
 *     Postgres tsvector path that retired with the Firestore migration.
 *   - **Substring degraded** (fallback): pull last 50 turns + filter
 *     in JS. Used when Algolia keys aren't configured (local dev,
 *     partial deploys). Same shape of output so callers don't notice.
 */
const SCAN_WINDOW = 50;

const InputSchema = z.object({
  keyword: z.string().min(1).describe("Phrase or keyword to match against narrative prose"),
  turn_range: z
    .object({ min: z.number().optional(), max: z.number().optional() })
    .optional()
    .describe("Optional turn-number window to restrict the search"),
  limit: z.number().int().min(1).max(20).default(5),
});

const OutputSchema = z.object({
  hits: z.array(
    z.object({
      turn: z.number(),
      score: z.number(),
      excerpt: z.string(),
    }),
  ),
});

/**
 * Build a ~200-char excerpt around the first match of `keyword` in
 * `text`. Used by the degraded path; Algolia returns its own snippet.
 */
function buildExcerpt(text: string, keyword: string): string {
  const lcText = text.toLowerCase();
  const lcKeyword = keyword.toLowerCase();
  const idx = lcText.indexOf(lcKeyword);
  if (idx < 0) return text.slice(0, 200);
  const radius = 100;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + keyword.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export const recallSceneTool = registerTool({
  name: "recall_scene",
  description:
    "Keyword search over the campaign's turn transcripts. Returns matching turn numbers with short prose excerpts. Use get_turn_narrative to pull a full turn after a hit.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("recall_scene: ctx.firestore not provided");

    // Algolia path — real full-text search.
    if (isAlgoliaConfigured()) {
      const hits = await searchTurns(
        ctx.campaignId,
        input.keyword,
        input.limit,
        input.turn_range
          ? { start: input.turn_range.min, end: input.turn_range.max }
          : undefined,
      );
      return {
        hits: hits.map((h) => ({
          turn: h.turnNumber,
          score: h.score,
          excerpt: h.excerpt,
        })),
      };
    }

    // Degraded fallback — substring match in JS over the last K turns.
    let q: Query = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.turns)
      .orderBy("turnNumber", "desc");
    if (input.turn_range?.min !== undefined) {
      q = q.where("turnNumber", ">=", input.turn_range.min);
    }
    if (input.turn_range?.max !== undefined) {
      q = q.where("turnNumber", "<=", input.turn_range.max);
    }
    q = q.limit(SCAN_WINDOW);

    const snap = await q.get();
    const lcKeyword = input.keyword.toLowerCase();
    const hits: Array<{ turn: number; score: number; excerpt: string }> = [];
    for (const doc of snap.docs) {
      const data = doc.data() as { turnNumber: number; narrativeText?: string | null };
      const narrative = data.narrativeText ?? "";
      if (!narrative) continue;
      if (!narrative.toLowerCase().includes(lcKeyword)) continue;
      hits.push({
        turn: data.turnNumber,
        score: 1.0,
        excerpt: buildExcerpt(narrative, input.keyword),
      });
      if (hits.length >= input.limit) break;
    }
    return { hits };
  },
});
