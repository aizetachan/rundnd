import { CAMPAIGN_SUB, COL, safeNameId } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Update a registered NPC's fields. Chronicler calls this when a turn
 * reveals new details — personality drift, new goal, faction reveal,
 * updated last_seen_turn. All fields optional except the lookup key
 * (id XOR name). Fields omitted from the input are left unchanged.
 *
 * For array fields (goals, secrets, visual_tags), the caller supplies
 * the full new array — this tool replaces, not appends. Chronicler's
 * prompt is responsible for reading current values (via
 * get_npc_details) and passing the merged result.
 *
 * Implementation: NPC doc id = safeNameId(name) (see register_npc).
 * Lookup-by-name resolves to the same id; lookup-by-id is a direct
 * path. set({...}, { merge: true }) leaves omitted keys untouched.
 */
const InputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    role: z.string().optional(),
    personality: z.string().optional(),
    goals: z.array(z.string()).optional(),
    secrets: z.array(z.string()).optional(),
    faction: z.string().nullable().optional(),
    visual_tags: z.array(z.string()).optional(),
    knowledge_topics: z.record(z.string(), z.enum(["expert", "moderate", "basic"])).optional(),
    power_tier: z.string().optional(),
    ensemble_archetype: z.string().nullable().optional(),
    last_seen_turn: z.number().int().positive().optional(),
  })
  .refine((v) => v.id !== undefined || v.name !== undefined, {
    message: "Must provide either id or name as the lookup key",
  });

const OutputSchema = z.object({
  id: z.string().min(1),
  updated: z.boolean(),
});

export const updateNpcTool = registerTool({
  name: "update_npc",
  description:
    "Update fields on an existing NPC (lookup by id or name). Omitted fields are left unchanged; jsonb arrays are replaced, not merged.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) throw new Error("update_npc: ctx.firestore not provided");

    // Resolve doc id. Both id and name route through the same safeNameId
    // namespace because register_npc uses the sanitized name as the doc id.
    let docId: string;
    if (input.id !== undefined) {
      docId = input.id;
    } else if (input.name !== undefined) {
      docId = safeNameId(input.name);
    } else {
      throw new Error("update_npc: Zod refinement failed to guarantee lookup key");
    }

    const ref = ctx.firestore
      .collection(COL.campaigns)
      .doc(ctx.campaignId)
      .collection(CAMPAIGN_SUB.npcs)
      .doc(docId);

    // Build patch; only include fields the caller passed. Snake↔camel
    // translation stays explicit.
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (input.role !== undefined) patch.role = input.role;
    if (input.personality !== undefined) patch.personality = input.personality;
    if (input.goals !== undefined) patch.goals = input.goals;
    if (input.secrets !== undefined) patch.secrets = input.secrets;
    if (input.faction !== undefined) patch.faction = input.faction;
    if (input.visual_tags !== undefined) patch.visualTags = input.visual_tags;
    if (input.knowledge_topics !== undefined) patch.knowledgeTopics = input.knowledge_topics;
    if (input.power_tier !== undefined) patch.powerTier = input.power_tier;
    if (input.ensemble_archetype !== undefined) patch.ensembleArchetype = input.ensemble_archetype;
    if (input.last_seen_turn !== undefined) patch.lastSeenTurn = input.last_seen_turn;

    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error(`update_npc: no NPC found (${input.id ?? input.name})`);
    }
    await ref.set(patch, { merge: true });
    return { id: docId, updated: true };
  },
});
