import { z } from "zod";

/**
 * ProgressionAgent — pure mechanical XP / level / stat-growth helper.
 *
 * No LLM. Character progression depth (M5 ROADMAP §) needs to feel
 * earned, not random. This module computes:
 *   - XP-to-next-level curve per IP power_distribution shape.
 *   - Level ups when total XP crosses a curve threshold.
 *   - Stat growth deltas applied at level-up (gentle, additive).
 *
 * KA + Chronicler call into this post-turn to award XP from
 * consequences + outcomes; the resulting Character mutation goes
 * through the existing entity-write tools.
 */

export const PowerTier = z.enum(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"]);
export type PowerTier = z.infer<typeof PowerTier>;

export const Gradient = z.enum(["spike", "top_heavy", "flat", "compressed"]);
export type Gradient = z.infer<typeof Gradient>;

/**
 * XP needed to reach `level` from level 1. Curve shape depends on the
 * source's power gradient — spike gradients (Solo Leveling) have steep
 * jumps at later levels; flat / compressed (Bebop) stay linear.
 */
export function xpForLevel(level: number, gradient: Gradient = "flat"): number {
  if (level <= 1) return 0;
  const base = 100;
  switch (gradient) {
    case "spike":
      // Quadratic: levels 1..10 → 0, 100, 400, 900, 1600, 2500...
      return base * (level - 1) * (level - 1);
    case "top_heavy":
      // 1.5-power: gentler than spike but still climbing.
      return Math.floor(base * (level - 1) ** 1.5);
    case "flat":
      // Linear: 100 per level.
      return base * (level - 1);
    case "compressed":
      // Sub-linear (sqrt): leveling feels easy at the start, plateaus.
      return Math.floor(base * Math.sqrt(level - 1) * 2);
  }
}

/**
 * Given current total XP, return the highest level the character has
 * earned (level 1 for 0 XP). O(maxLevel) lookup; maxLevel is 20 in
 * practice so this is trivially fast.
 */
export function levelForXp(totalXp: number, gradient: Gradient = "flat"): number {
  if (totalXp < 0) return 1;
  let level = 1;
  for (let lvl = 2; lvl <= 50; lvl++) {
    if (xpForLevel(lvl, gradient) > totalXp) break;
    level = lvl;
  }
  return level;
}

/**
 * XP to award for a turn outcome. Coarse rubric tied to OJ's
 * narrative_weight + success_level:
 *   MINOR success      → 10
 *   MINOR fail/partial → 5
 *   SIGNIFICANT *      → 25
 *   CLIMACTIC *        → 60
 *
 * The rubric is intentionally readable — content authors can tune.
 */
export function xpAward(
  narrative_weight: "MINOR" | "SIGNIFICANT" | "CLIMACTIC",
  success_level: "critical_success" | "success" | "partial_success" | "fail" | "critical_fail",
): number {
  if (narrative_weight === "MINOR") {
    return success_level === "success" || success_level === "critical_success" ? 10 : 5;
  }
  if (narrative_weight === "SIGNIFICANT") return 25;
  return 60;
}

/**
 * Decision: did this XP delta cross a level threshold? Returns the
 * new level when yes (caller persists), the existing level when no
 * change.
 */
export function applyXpDelta(
  currentXp: number,
  delta: number,
  gradient: Gradient = "flat",
): { newXp: number; newLevel: number; leveledUp: boolean } {
  const newXp = Math.max(0, currentXp + delta);
  const before = levelForXp(currentXp, gradient);
  const after = levelForXp(newXp, gradient);
  return { newXp, newLevel: after, leveledUp: after > before };
}

/**
 * Stat growth delta at level-up. Gentle: 1-2 points across a single
 * stat each level depending on gradient. Caller picks which stat (KA
 * narrates the choice in voice — "you've gotten faster" / "more
 * patient" / etc.).
 */
export function levelUpStatBonus(gradient: Gradient = "flat"): number {
  switch (gradient) {
    case "spike":
      return 2;
    case "top_heavy":
      return 2;
    case "flat":
      return 1;
    case "compressed":
      return 1;
  }
}
