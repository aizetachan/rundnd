import { CAMPAIGN_SUB, COL, safeNameId } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Register a new location in the campaign's catalog. No-op on conflict
 * by name. `details` is a free-form record — description, notable
 * features, faction ownership, etc. Shape firms up as profiles mature.
 * Chronicler calls this post-turn for every named place KA introduced;
 * re-calls are safe (idempotent by name).
 *
 * Implementation: doc id = safeNameId(name). Firestore guarantees doc
 * id uniqueness within a collection, so two concurrent calls with the
 * same name converge on the same doc instead of creating duplicates.
 */
const InputSchema = z.object({
  name: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  first_seen_turn: z.number().int().positive(),
  last_seen_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().min(1),
  created: z.boolean(),
});

export const registerLocationTool = registerTool({
  name: "register_location",
  description:
    "Register a new location in the campaign's catalog. No-op if a location with this name already exists. Returns the location id.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("register_location: ctx.firestore not provided");
    const id = safeNameId(input.name);
    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.locations)
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
        firstSeenTurn: input.first_seen_turn,
        lastSeenTurn: input.last_seen_turn,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { id, created: true };
    });
  },
});
