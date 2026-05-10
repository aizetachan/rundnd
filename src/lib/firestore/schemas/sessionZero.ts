import { SessionZeroState } from "@/lib/types/session-zero";
import { z } from "zod";

/**
 * `campaigns/{campaignId}/sessionZero/state` — single doc per campaign
 * holding the in-progress onboarding state. Doc id is the literal
 * string "state" (one SZ per campaign; redo creates a new campaign +
 * marks the prior one superseded rather than overwriting in place).
 *
 * The `id` field is added on read and equals the parent campaignId.
 */
export const FirestoreSessionZero = SessionZeroState.extend({
  id: z.string(), // == "state" (constant; the parent campaignId is in campaignId field)
});
export type FirestoreSessionZero = z.infer<typeof FirestoreSessionZero>;

/**
 * `campaigns/{campaignId}/openingStatePackages/{packageId}` — versioned
 * artifact of the HandoffCompiler output. Multiple docs per campaign if
 * SZ is redone before first gameplay turn (each redo writes a new
 * package, supersede pointer + content_hash dedup).
 */
export const FirestoreOpeningStatePackageRef = z.object({
  id: z.string(),
  campaignId: z.string(),
  contentHash: z.string(),
  supersedes: z.string().nullable().optional(),
  package: z.unknown(), // OpeningStatePackage parsed at the consumer; stored as opaque jsonb-like
  createdAt: z.date(),
});
export type FirestoreOpeningStatePackageRef = z.infer<typeof FirestoreOpeningStatePackageRef>;
