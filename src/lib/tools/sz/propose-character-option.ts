import { PowerTier } from "@/lib/types/profile";
import { z } from "zod";
import { registerTool } from "../registry";
import { appendConductorToolCall } from "./_history";

/**
 * Conductor proposes 2–3 character options for the player to react to.
 * The tool itself doesn't commit anything to the character draft — it
 * appends a `tool_call` entry to `conversation_history` so:
 *   1. The UI can render the options as cards/buttons next to the
 *      streamed text.
 *   2. A future resume reads conversation_history and replays the
 *      proposal without re-invoking the conductor.
 *
 * Selection happens in-conversation: the player picks an option, the
 * conductor reads that reply, and writes the chosen fields via
 * `commit_field` calls (one per field, or several batched per turn).
 *
 * The conductor calls this once it has enough context (profile +
 * canonicality_mode) to ground concrete options. Calling it earlier
 * forces the player to choose before they understand the world; calling
 * it later wastes turns on free-text elicitation that options would
 * shortcut.
 */
const CharacterOption = z.object({
  /** Short label the UI uses on the card. 1–4 words. */
  label: z.string().min(1),
  name: z.string().min(1),
  /** One-sentence concept that captures the archetype + hook. */
  concept: z.string().min(1),
  power_tier: PowerTier,
  abilities_sketch: z.string().min(1),
  appearance_sketch: z.string().min(1),
  personality_sketch: z.string().min(1),
  backstory_sketch: z.string().min(1),
});

const InputSchema = z.object({
  /**
   * 2–3 distinct options. Distinctness matters: three flavors of the
   * same archetype is a dud proposal — the player learns nothing about
   * what they want.
   */
  options: z.array(CharacterOption).min(2).max(3),
  /**
   * Why these three. Surfaced to the player so they understand the
   * design space, not just the picks. Keep tight — 1–2 sentences.
   */
  rationale: z.string().min(1),
});

const OutputSchema = z.object({
  ok: z.literal(true),
  options_count: z.number().int().positive(),
});

export const proposeCharacterOptionTool = registerTool({
  name: "propose_character_option",
  description:
    "Propose 2–3 distinct character options the player can react to. Surfaces them to the UI as cards. Does NOT commit any field — use commit_field after the player picks. Call once you have profile + canonicality_mode pinned.",
  layer: "session_zero",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) {
      throw new Error("propose_character_option: ctx.firestore not provided");
    }
    const result = { ok: true as const, options_count: input.options.length };
    await appendConductorToolCall({
      firestore: ctx.firestore,
      campaignId: ctx.campaignId,
      toolName: "propose_character_option",
      args: input,
      result,
    });
    return result;
  },
});
