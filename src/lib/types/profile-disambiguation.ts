import { FranchiseCandidate } from "@/lib/research/types";
import { z } from "zod";

/**
 * Conductor surface for franchise-graph disambiguation. When the
 * player names "Naruto" and the research path returns multiple distinct
 * entries (Naruto, Naruto Shippuden, Boruto), the conductor presents
 * this payload to the player as a short numbered list. The player
 * picks; the conductor commits the chosen `anilist_id` into research
 * input for the second pass.
 */
export const ProfileDisambiguationOptions = z.object({
  query: z.string(),
  candidates: z.array(FranchiseCandidate).min(1).max(8),
});
export type ProfileDisambiguationOptions = z.infer<typeof ProfileDisambiguationOptions>;
