import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Pull the full narrative prose of a specific turn. Used after
 * `recall_scene` returns a hit — the hit gives you the turn number
 * and a short excerpt; this tool gives you the actual prose to weave
 * a callback from.
 */
const InputSchema = z.object({
  turn_number: z.number().int().positive(),
});

const OutputSchema = z.object({
  available: z.boolean(),
  turn_number: z.number(),
  player_message: z.string().nullable(),
  narrative_text: z.string().nullable(),
  intent: z.string().nullable(),
  outcome_summary: z.string().nullable(),
});

export const getTurnNarrativeTool = registerTool({
  name: "get_turn_narrative",
  description:
    "Return the full narrative prose of a specific turn, plus the player message, intent, and outcome that produced it.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("get_turn_narrative: ctx.firestore not provided");
    const snap = await ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.turns)
      .where("turnNumber", "==", input.turn_number)
      .limit(1)
      .get();
    const doc = snap.docs[0];
    if (!doc) {
      return {
        available: false,
        turn_number: input.turn_number,
        player_message: null,
        narrative_text: null,
        intent: null,
        outcome_summary: null,
      };
    }
    const row = doc.data() as {
      turnNumber: number;
      playerMessage?: string | null;
      narrativeText?: string | null;
      intent?: unknown;
      outcome?: unknown;
    };
    const intentType =
      row.intent && typeof row.intent === "object" && "intent" in row.intent
        ? String((row.intent as { intent: unknown }).intent)
        : null;
    const outcomeSummary =
      row.outcome && typeof row.outcome === "object" && "rationale" in row.outcome
        ? String((row.outcome as { rationale: unknown }).rationale)
        : null;
    return {
      available: true,
      turn_number: row.turnNumber,
      player_message: row.playerMessage ?? null,
      narrative_text: row.narrativeText ?? null,
      intent: intentType,
      outcome_summary: outcomeSummary,
    };
  },
});
