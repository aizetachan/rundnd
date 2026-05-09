import { z } from "zod";

/**
 * `campaigns/{campaignId}/voicePatterns/{patternId}` — Director's
 * voice-patterns journal. Append-only.
 */
export const FirestoreVoicePattern = z.object({
  id: z.string(),
  campaignId: z.string(),
  pattern: z.string(),
  evidence: z.string().default(""),
  turnObserved: z.number().int().nonnegative(),
  createdAt: z.date(),
});
export type FirestoreVoicePattern = z.infer<typeof FirestoreVoicePattern>;
