import { COL } from "@/lib/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Return active player overrides — `/override` hard constraints the
 * player has issued for this campaign. KA reads these via Block 4 as
 * the `## PLAYER OVERRIDES (MUST BE ENFORCED)` block. This tool exists
 * so KA can also query them directly when writing a scene where an
 * override's applicability isn't obvious from the per-turn context.
 *
 * Reads from `campaigns/{id}.settings.overrides` (jsonb-equivalent map).
 */
const OverrideSchema = z.object({
  id: z.string(),
  category: z.enum([
    "NPC_PROTECTION",
    "CONTENT_CONSTRAINT",
    "NARRATIVE_DEMAND",
    "TONE_REQUIREMENT",
  ]),
  value: z.string(),
  scope: z.enum(["campaign", "session", "arc"]).default("campaign"),
  created_at: z.string(),
});

const InputSchema = z.object({});

const OutputSchema = z.object({
  overrides: z.array(OverrideSchema),
});

export const getOverridesTool = registerTool({
  name: "get_overrides",
  description:
    "Return active player overrides (hard constraints) for this campaign. Use when checking whether a narrative direction conflicts with a rule the player set.",
  layer: "critical",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, ctx) => {
    if (!ctx.firestore) return { overrides: [] };
    const snap = await ctx.firestore.collection(COL.campaigns).doc(ctx.campaignId).get();
    if (!snap.exists) return { overrides: [] };
    const data = snap.data();
    if (!data || data.ownerUid !== ctx.userId || data.deletedAt !== null) {
      return { overrides: [] };
    }
    const settings = (data.settings ?? {}) as { overrides?: unknown };
    const raw = settings.overrides;
    if (!Array.isArray(raw)) return { overrides: [] };
    // Tolerant parse — skip malformed entries rather than fail the call.
    const parsed: z.infer<typeof OverrideSchema>[] = [];
    for (const item of raw) {
      const result = OverrideSchema.safeParse(item);
      if (result.success) parsed.push(result.data);
    }
    return { overrides: parsed };
  },
});
