import { z } from "zod";
import { registerTool } from "../registry";
import { appendConductorToolCall } from "./_history";

/**
 * Conductor asks the player a focused clarifying question. Surfaced to
 * the UI as a question prompt (vs free narration), so the UI can mark
 * the chat as "awaiting answer" and surface a focused input affordance.
 *
 * The streamed conductor text is the question's full prose; this tool
 * tags the turn with the question's `topic` + `field_target` so the
 * resume UI can summarize "the conductor asked about X" without
 * re-running the agent.
 *
 * Use sparingly. Most conductor turns should advance via narration +
 * proposals, not direct interrogation. If you find yourself asking 3+
 * questions in a row, the conductor is fishing — propose options
 * instead.
 */
const InputSchema = z.object({
  /**
   * The question text. Should match the streamed text exactly so the UI
   * can render either; persistence prefers this field as the canonical
   * form.
   */
  question: z.string().min(1),
  /**
   * What the question is fishing for. Free-text — used for analytics +
   * resume UX, not validated against an enum so the conductor isn't
   * boxed into a fixed taxonomy.
   */
  topic: z.string().min(1),
  /**
   * The CharacterDraft / SessionZeroState field this question is
   * elicit-ing toward, if any. Optional: not every question maps to a
   * single field (e.g. tonal preferences, profile clarification).
   */
  field_target: z
    .enum([
      "character_name",
      "character_concept",
      "power_tier",
      "abilities",
      "appearance",
      "personality",
      "backstory",
      "voice_notes",
      "starting_location",
      "starting_situation",
      "canonicality_mode",
      "profile_refs",
    ])
    .nullable()
    .optional(),
});

const OutputSchema = z.object({
  ok: z.literal(true),
  question: z.string(),
});

export const askClarifyingQuestionTool = registerTool({
  name: "ask_clarifying_question",
  description:
    "Tag the current conductor turn as a focused question. Use when the conductor needs information from the player to advance (vs free narration). The streamed text carries the prose; this tool tags topic + field_target for the UI and resume flow. Use sparingly — propose options when possible.",
  layer: "session_zero",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) {
      throw new Error("ask_clarifying_question: ctx.firestore not provided");
    }
    const result = { ok: true as const, question: input.question };
    await appendConductorToolCall({
      firestore: ctx.firestore,
      campaignId: ctx.campaignId,
      toolName: "ask_clarifying_question",
      args: input,
      result,
      text: input.question,
    });
    return result;
  },
});
