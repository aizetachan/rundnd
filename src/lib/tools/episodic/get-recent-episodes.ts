import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Return short summaries of the most recent N turns for continuity
 * context. If KA wants the actual prose of a specific turn, use
 * `get_turn_narrative` instead.
 *
 * Uses `turns.summary` when populated (by the memory writer at M4+);
 * falls back to the first 200 chars of `narrative_text` so M1 play
 * gets useful continuity before the writer is online.
 */
const InputSchema = z.object({
  n: z.number().int().min(1).max(20).default(5),
});

const OutputSchema = z.object({
  episodes: z.array(
    z.object({
      turn_number: z.number(),
      summary: z.string(),
      intent: z.string().nullable(),
    }),
  ),
});

export const getRecentEpisodesTool = registerTool({
  name: "get_recent_episodes",
  description: "Return short summaries of the most recent N turns for continuity context.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("get_recent_episodes: ctx.firestore not provided");
    const snap = await ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.turns)
      .orderBy("turnNumber", "desc")
      .limit(input.n)
      .get();

    const rows = snap.docs.map((d) => {
      const data = d.data() as {
        turnNumber: number;
        summary?: string | null;
        narrativeText?: string | null;
        intent?: unknown;
      };
      return {
        turn_number: data.turnNumber,
        summary: data.summary ?? null,
        narrative_text: data.narrativeText ?? null,
        intent: data.intent ?? null,
      };
    });

    // Return oldest → newest so continuity reads naturally.
    const ordered = rows.slice().reverse();

    return {
      episodes: ordered.map((r) => {
        const intentType =
          r.intent && typeof r.intent === "object" && "intent" in r.intent
            ? String((r.intent as { intent: unknown }).intent)
            : null;
        const fallback = (r.narrative_text ?? "").slice(0, 200);
        return {
          turn_number: r.turn_number,
          summary: r.summary ?? fallback,
          intent: intentType,
        };
      }),
    };
  },
});
