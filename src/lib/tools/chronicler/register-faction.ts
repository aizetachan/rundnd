import { CAMPAIGN_SUB, COL, safeNameId } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Register a new faction (organization, syndicate, government, etc.)
 * in the campaign's catalog. No-op on conflict by name. `details` is a
 * free-form record — goals, leadership, member NPCs by name, etc.
 * Chronicler calls this when KA introduces an organization that isn't
 * already catalogued.
 *
 * Implementation: doc id = safeNameId(name). Firestore guarantees doc
 * id uniqueness within a collection, so two concurrent calls with the
 * same name converge on the same doc instead of creating duplicates.
 */
const InputSchema = z.object({
  name: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

const OutputSchema = z.object({
  id: z.string().min(1),
  created: z.boolean(),
});

export const registerFactionTool = registerTool({
  name: "register_faction",
  description:
    "Register a new faction in the campaign's catalog. No-op if a faction with this name already exists. Returns the faction id.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("register_faction: ctx.firestore not provided");
    const id = safeNameId(input.name);
    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.factions)
      .doc(id);

    return await ctx.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        return { id, created: false };
      }
      tx.set(ref, {
        campaignId: ctx.campaignId,
        name: input.name,
        details: input.details ?? {},
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { id, created: true };
    });
  },
});
