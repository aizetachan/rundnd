import { z } from "zod";

/**
 * `campaigns/{campaignId}` — campaign root. Top-level so cross-user admin
 * queries (e.g. "all active campaigns") can use a collection-group query
 * and security rules enforce ownership via `ownerUid`.
 *
 * `settings` holds the active tonal state — active_dna, active_composition,
 * arc_override, world_state, overrides, hybrid_synthesis_notes, etc.
 * Stored as opaque `unknown` here; the typed `Campaign` (src/lib/types/...)
 * does the deep parse on read. Storing it whole means the shape can evolve
 * without schema migrations mid-arc.
 */
export const CampaignPhase = z.enum(["sz", "playing", "archived"]);
export type CampaignPhase = z.infer<typeof CampaignPhase>;

export const FirestoreCampaign = z.object({
  id: z.string(),
  ownerUid: z.string(), // matches users/{uid}; replaces the SQL FK
  name: z.string(),
  phase: CampaignPhase.default("sz"),
  /**
   * Slugs the campaign draws from. Single = single-source adaptation;
   * multiple = hybrid. Read via Zod `Campaign.profile_refs` on load.
   */
  profileRefs: z.array(z.string()).default([]),
  settings: z.unknown(),
  createdAt: z.date(),
  deletedAt: z.date().nullable().optional(),
});
export type FirestoreCampaign = z.infer<typeof FirestoreCampaign>;
