import { CAMPAIGN_SUB, COL, safeNameId } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Register a new NPC in the campaign's catalog. Chronicler calls this
 * post-turn when it detects a named character that isn't yet in the
 * subcollection. Idempotent on (campaignId, name) — second call with
 * the same name returns the existing id.
 *
 * Implementation: doc id = safeNameId(name). Firestore guarantees doc
 * id uniqueness within a collection, so two concurrent calls with the
 * same name converge on the same doc instead of creating duplicates
 * (the race-prone query+insert pattern that Postgres hid behind ON
 * CONFLICT). `created` is true when the doc didn't exist before this
 * call.
 */
const InputSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  personality: z.string().optional(),
  goals: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  faction: z.string().nullable().optional(),
  visual_tags: z.array(z.string()).optional(),
  knowledge_topics: z.record(z.string(), z.enum(["expert", "moderate", "basic"])).optional(),
  power_tier: z.string().optional(),
  ensemble_archetype: z.string().nullable().optional(),
  first_seen_turn: z.number().int().positive(),
  last_seen_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string(),
  created: z.boolean(),
});

export const registerNpcTool = registerTool({
  name: "register_npc",
  description:
    "Register a new NPC in the campaign's catalog. No-op if an NPC with this name already exists — use update_npc to change fields. Returns the NPC id for downstream references (relationship events, spotlight debt).",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("register_npc: ctx.firestore not provided");
    const id = safeNameId(input.name);
    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.npcs)
      .doc(id);

    return await ctx.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        return { id, created: false };
      }
      tx.set(ref, {
        campaignId: ctx.campaignId,
        name: input.name,
        role: input.role ?? "acquaintance",
        personality: input.personality ?? "",
        goals: input.goals ?? [],
        secrets: input.secrets ?? [],
        faction: input.faction ?? null,
        visualTags: input.visual_tags ?? [],
        knowledgeTopics: input.knowledge_topics ?? {},
        powerTier: input.power_tier ?? "T10",
        ensembleArchetype: input.ensemble_archetype ?? null,
        isTransient: false,
        firstSeenTurn: input.first_seen_turn,
        lastSeenTurn: input.last_seen_turn,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { id, created: true };
    });
  },
});
