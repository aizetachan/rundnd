import { z } from "zod";

export const ArcPhase = z.enum(["setup", "development", "complication", "crisis", "resolution"]);
export type ArcPhase = z.infer<typeof ArcPhase>;

export const ArcMode = z.enum([
  "main_arc",
  "ensemble_arc",
  "adversary_ensemble_arc",
  "ally_ensemble_arc",
  "investigator_arc",
  "faction_arc",
]);
export type ArcMode = z.infer<typeof ArcMode>;

/**
 * `campaigns/{campaignId}/arcPlanHistory/{historyId}` — append-only
 * snapshot of Director's arc decisions. Latest doc by createdAt is
 * the current state.
 */
export const FirestoreArcPlanHistory = z.object({
  id: z.string(),
  campaignId: z.string(),
  currentArc: z.string(),
  arcPhase: ArcPhase,
  arcMode: ArcMode,
  plannedBeats: z.array(z.unknown()).default([]),
  tensionLevel: z.number().min(0).max(1).default(0.3),
  setAtTurn: z.number().int().nonnegative(),
  createdAt: z.date(),
});
export type FirestoreArcPlanHistory = z.infer<typeof FirestoreArcPlanHistory>;
