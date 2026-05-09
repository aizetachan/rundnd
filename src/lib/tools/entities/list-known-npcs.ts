import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * List every catalog NPC in this campaign with a brief summary.
 *
 * Phase 6A of v3-audit closure: transient NPCs (spawn_transient) are
 * excluded from this view by default because they're scene-local flavor
 * and would drown the catalog. Pass `include_transient: true` to get
 * everyone (rare; useful for debugging or admin views).
 *
 * Affinity is not currently tracked as a numeric column — returns 0 as
 * a placeholder until relationship-events aggregate into a score (M4).
 */
const InputSchema = z.object({
  include_transient: z.boolean().default(false),
});

const OutputSchema = z.object({
  npcs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.string().nullable(),
      brief: z.string(),
      affinity: z.number(),
    }),
  ),
});

export const listKnownNpcsTool = registerTool({
  name: "list_known_npcs",
  description:
    "List catalog NPCs in this campaign with id, name, role, brief summary. Excludes transients (flavor characters) by default; pass include_transient=true to see all.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) return { npcs: [] };
    const baseQuery = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.npcs);
    const query = input.include_transient
      ? baseQuery.orderBy("name", "asc").limit(200)
      : baseQuery.where("isTransient", "==", false).orderBy("name", "asc").limit(200);
    const snap = await query.get();
    return {
      npcs: snap.docs.map((d) => {
        const r = d.data();
        return {
          id: d.id,
          name: r.name,
          role: r.role ?? null,
          brief: r.personality || "(no personality inferred yet)",
          affinity: 0,
        };
      }),
    };
  },
});
