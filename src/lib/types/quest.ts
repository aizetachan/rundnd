import { z } from "zod";

/**
 * Quest entity (M5). Active objective + progress tracker that KA
 * can reference in narration and Chronicler can update.
 *
 * Quests aren't tightly mechanical — they're prompt-visible state.
 * Status tracks whether they're still open; progress is a 0..1
 * fraction for soft signaling.
 */

export const QuestStatus = z.enum(["active", "complete", "failed", "abandoned", "blocked"]);
export type QuestStatus = z.infer<typeof QuestStatus>;

export const Quest = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().min(1),
  status: QuestStatus,
  progress: z.number().min(0).max(1).default(0),
  givenByNpcId: z.string().optional(),
  rewardHint: z.string().optional(),
  createdAtTurn: z.number().int().nonnegative(),
  updatedAtTurn: z.number().int().nonnegative(),
});
export type Quest = z.infer<typeof Quest>;

/**
 * Consequence entity (M5). Ripple effect of a past action that
 * matures or worsens over time. KA can reference active consequences
 * in scene framing.
 */
export const ConsequenceSeverity = z.enum(["light", "moderate", "severe", "catastrophic"]);
export type ConsequenceSeverity = z.infer<typeof ConsequenceSeverity>;

export const Consequence = z.object({
  id: z.string(),
  description: z.string().min(1),
  severity: ConsequenceSeverity,
  originTurn: z.number().int().nonnegative(),
  /** True when the consequence has fully landed and is no longer
   *  active. Caller flips this when narrative resolves it. */
  resolved: z.boolean().default(false),
  resolvedAtTurn: z.number().int().nonnegative().optional(),
  /** Optional npc / faction / location the consequence is bound to. */
  affectsEntityId: z.string().optional(),
});
export type Consequence = z.infer<typeof Consequence>;
