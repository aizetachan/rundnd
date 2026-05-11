/**
 * Profile-generation scorer. Compares a produced AnimeResearchOutput
 * (from Path A or Path B) against a hand-authored ground-truth
 * Profile loaded from `evals/golden/profiles/*.yaml`.
 *
 * Mechanical axes (this file):
 *   - DNA delta — sum of absolute differences across the 24 axes.
 *   - Trope agreement — disagreement count across 15 boolean axes.
 *   - Power-tier delta — ordinal distance on peak / typical / floor.
 *   - Stat-mapping correctness — binary: did the path detect canonical
 *     stats where they exist (Solo Leveling) and skip them where they
 *     don't (Cowboy Bebop)?
 *
 * Gemini-as-judge soft axes (voice-card quality, visual-style
 * alignment) are deferred to a follow-up — they need a wrapper around
 * `@google/genai` + rubric prompts that warrant their own commit.
 *
 * The "decision" surface — whether Path B alone is good enough to
 * retire Path A — consumes these four axes per the ROADMAP §10.6
 * thresholds (DNA delta < 30 summed across the 24 axes, trope
 * disagreements < 3 of 15, stat mapping correct on every IP, judge
 * scores within 0.3 once the soft axes ship).
 */

import type { AnimeResearchOutput } from "@/lib/research";
import type { Profile } from "@/lib/types/profile";

const DNA_AXES = [
  "pacing",
  "continuity",
  "density",
  "temporal_structure",
  "optimism",
  "darkness",
  "comedy",
  "emotional_register",
  "intimacy",
  "fidelity",
  "reflexivity",
  "avant_garde",
  "epistemics",
  "moral_complexity",
  "didacticism",
  "cruelty",
  "power_treatment",
  "scope",
  "agency",
  "interiority",
  "conflict_style",
  "register",
  "empathy",
  "accessibility",
] as const satisfies ReadonlyArray<keyof Profile["canonical_dna"]>;

const TROPE_AXES = [
  "tournament_arc",
  "training_montage",
  "power_of_friendship",
  "mentor_death",
  "chosen_one",
  "tragic_backstory",
  "redemption_arc",
  "betrayal",
  "sacrifice",
  "transformation",
  "forbidden_technique",
  "time_loop",
  "false_identity",
  "ensemble_focus",
  "slow_burn_romance",
] as const satisfies ReadonlyArray<keyof Profile["ip_mechanics"]["storytelling_tropes"]>;

const TIER_ORDER = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"] as const;

export interface IpScore {
  ip_slug: string;
  dna_delta_sum: number;
  dna_delta_by_axis: Record<string, number>;
  trope_disagreements: number;
  trope_disagreements_by_axis: string[];
  power_tier_delta: {
    peak: number;
    typical: number;
    floor: number;
    sum: number;
  };
  stat_mapping_correct: boolean;
  /** Aggregate "pass" against ROADMAP §10.6 mechanical thresholds.
   *  Soft (judge) axes evaluated separately when they ship. */
  passes_mechanical: boolean;
}

function tierIndex(tier: string): number {
  const i = (TIER_ORDER as readonly string[]).indexOf(tier);
  return i < 0 ? 0 : i;
}

export function scoreDnaDelta(
  produced: AnimeResearchOutput["canonical_dna"],
  groundTruth: Profile["canonical_dna"],
): { sum: number; by_axis: Record<string, number> } {
  const byAxis: Record<string, number> = {};
  let sum = 0;
  for (const axis of DNA_AXES) {
    const a = Number(produced[axis] ?? 0);
    const b = Number(groundTruth[axis] ?? 0);
    const diff = Math.abs(a - b);
    byAxis[axis] = diff;
    sum += diff;
  }
  return { sum, by_axis: byAxis };
}

export function scoreTropeAgreement(
  produced: AnimeResearchOutput["ip_mechanics"]["storytelling_tropes"],
  groundTruth: Profile["ip_mechanics"]["storytelling_tropes"],
): { disagreements: number; axes: string[] } {
  const disagreed: string[] = [];
  for (const axis of TROPE_AXES) {
    if (produced[axis] !== groundTruth[axis]) disagreed.push(axis);
  }
  return { disagreements: disagreed.length, axes: disagreed };
}

export function scorePowerTierDelta(
  produced: AnimeResearchOutput["ip_mechanics"]["power_distribution"],
  groundTruth: Profile["ip_mechanics"]["power_distribution"],
): IpScore["power_tier_delta"] {
  const peak = Math.abs(tierIndex(produced.peak_tier) - tierIndex(groundTruth.peak_tier));
  const typical = Math.abs(tierIndex(produced.typical_tier) - tierIndex(groundTruth.typical_tier));
  const floor = Math.abs(tierIndex(produced.floor_tier) - tierIndex(groundTruth.floor_tier));
  return { peak, typical, floor, sum: peak + typical + floor };
}

export function scoreStatMapping(
  produced: AnimeResearchOutput["ip_mechanics"]["stat_mapping"],
  groundTruth: Profile["ip_mechanics"]["stat_mapping"],
): boolean {
  return produced.has_canonical_stats === groundTruth.has_canonical_stats;
}

const DNA_DELTA_THRESHOLD = 30;
const TROPE_DISAGREEMENT_THRESHOLD = 3;

export function scoreIp(
  ip_slug: string,
  produced: AnimeResearchOutput,
  groundTruth: Profile,
): IpScore {
  const dna = scoreDnaDelta(produced.canonical_dna, groundTruth.canonical_dna);
  const tropes = scoreTropeAgreement(
    produced.ip_mechanics.storytelling_tropes,
    groundTruth.ip_mechanics.storytelling_tropes,
  );
  const power = scorePowerTierDelta(
    produced.ip_mechanics.power_distribution,
    groundTruth.ip_mechanics.power_distribution,
  );
  const stat = scoreStatMapping(
    produced.ip_mechanics.stat_mapping,
    groundTruth.ip_mechanics.stat_mapping,
  );
  return {
    ip_slug,
    dna_delta_sum: dna.sum,
    dna_delta_by_axis: dna.by_axis,
    trope_disagreements: tropes.disagreements,
    trope_disagreements_by_axis: tropes.axes,
    power_tier_delta: power,
    stat_mapping_correct: stat,
    passes_mechanical:
      dna.sum < DNA_DELTA_THRESHOLD && tropes.disagreements < TROPE_DISAGREEMENT_THRESHOLD && stat,
  };
}

export function summarizeScores(scores: IpScore[]): {
  ip_count: number;
  dna_delta_avg: number;
  trope_disagreements_avg: number;
  stat_mapping_correct_rate: number;
  pass_rate: number;
} {
  if (scores.length === 0) {
    return {
      ip_count: 0,
      dna_delta_avg: 0,
      trope_disagreements_avg: 0,
      stat_mapping_correct_rate: 0,
      pass_rate: 0,
    };
  }
  const sumDna = scores.reduce((acc, s) => acc + s.dna_delta_sum, 0);
  const sumTropes = scores.reduce((acc, s) => acc + s.trope_disagreements, 0);
  const statCorrect = scores.filter((s) => s.stat_mapping_correct).length;
  const passed = scores.filter((s) => s.passes_mechanical).length;
  return {
    ip_count: scores.length,
    dna_delta_avg: sumDna / scores.length,
    trope_disagreements_avg: sumTropes / scores.length,
    stat_mapping_correct_rate: statCorrect / scores.length,
    pass_rate: passed / scores.length,
  };
}
