import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Diagnostic / trigger for working-memory compaction. Chronicler calls
 * this at the end of a post-turn pass; the tool returns whether the
 * campaign has enough turns to warrant compaction and, if so, the
 * oldest N turns' narratives so Chronicler can synthesize a compacted
 * summary and write it via `write_semantic_memory` (category "episode").
 *
 * This is a read + advise tool, not a write tool. Separating the
 * compaction decision from the summarization LLM call keeps Chronicler
 * as the orchestrator: it reads the oldest turns, composes a prose
 * summary, and writes it via the same semantic-memory path as any
 * other fact. No nested LLM calls in tools — every LLM call belongs
 * to an agent with a trace and a budget.
 *
 * M1 default threshold is 20; M4+ the working-memory architecture may
 * tune this per-campaign.
 *
 * Implementation: a count() aggregation gates the compaction decision
 * cheaply, and we only fetch the oldest `compact_count` turn docs when
 * we cross the threshold. Ordering by turnNumber ascending matches the
 * v3 SQL ORDER BY turn_number ASC.
 */
const InputSchema = z.object({
  threshold: z.number().int().min(5).max(100).default(20),
  compact_count: z.number().int().min(1).max(50).default(10),
});

const OutputSchema = z.object({
  turn_count: z.number().int().nonnegative(),
  threshold: z.number().int().positive(),
  should_compact: z.boolean(),
  oldest_turns: z.array(
    z.object({
      turn_number: z.number().int().positive(),
      narrative_text: z.string(),
      summary: z.string().nullable(),
    }),
  ),
});

export const triggerCompactorTool = registerTool({
  name: "trigger_compactor",
  description:
    "Check if working memory has exceeded the compaction threshold; if so, return the oldest N turns' narratives so Chronicler can synthesize + write a compacted summary via write_semantic_memory (category 'episode'). Read-only; no writes performed here.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("trigger_compactor: ctx.firestore not provided");
    const turnsCol = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.turns);

    const countSnap = await turnsCol.count().get();
    const turnCount = countSnap.data().count;
    const shouldCompact = turnCount > input.threshold;

    let oldestTurns: Array<{
      turn_number: number;
      narrative_text: string;
      summary: string | null;
    }> = [];
    if (shouldCompact) {
      const oldestSnap = await turnsCol
        .orderBy("turnNumber", "asc")
        .limit(input.compact_count)
        .get();
      oldestTurns = oldestSnap.docs.map((d) => {
        const r = d.data();
        return {
          turn_number: r.turnNumber as number,
          narrative_text: (r.narrativeText as string) ?? "",
          summary: (r.summary as string | null | undefined) ?? null,
        };
      });
    }

    return {
      turn_count: turnCount,
      threshold: input.threshold,
      should_compact: shouldCompact,
      oldest_turns: oldestTurns,
    };
  },
});
