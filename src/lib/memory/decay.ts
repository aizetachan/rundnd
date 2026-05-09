import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Semantic-memory heat physics (§9.1 decay curves — v3-parity Phase 4).
 *
 * Heat is on [0, 100]. At insert it's 100 by default ("start hot, let
 * decay do the work"). Each turn-distance applies the category's decay
 * multiplier (compounding); floors respect `plot_critical` +
 * `milestone_relationship` flags. Without decay, every memory sits at
 * insert-time heat forever — retrieval ranking reduces to recency +
 * hand-waved baseline, and the long tail clogs candidate pools.
 *
 * v3 ran decay at read time (compute heat on-query). v4 runs it at
 * turn-close (Chronicler end-of-pass) so every read is cheap and no
 * query needs to reimplement the formula. The tradeoff: a memory
 * queried between decay runs sees yesterday's value — acceptable at
 * turn granularity.
 *
 * Boost-on-access: every candidate returned by `search_memory` gets a
 * heat bump — relationships +30, others +20 — clamped at 100. Keeps
 * frequently-relevant memories hot even as background decay chips away.
 *
 * Static boost (M4 retrieval runtime): session_zero / plot_critical get
 * +0.3 relevance bump, `episode` gets +0.15, applied after cosine + before
 * MemoryRanker rerank. Scaffolded here via `STATIC_BOOST`; wired in M4.
 */

export type DecayCurve = "none" | "very_slow" | "slow" | "normal" | "fast" | "very_fast";

/**
 * Per-curve multipliers applied per turn of distance from a memory's
 * turn_number. heat_new = heat_old * multiplier^(delta_turns). v3 values
 * verbatim.
 */
export const DECAY_CURVES: Record<DecayCurve, number> = {
  none: 1.0,
  very_slow: 0.97,
  slow: 0.95,
  normal: 0.9,
  fast: 0.8,
  very_fast: 0.7,
};

/**
 * Category → decay curve mapping. Chronicler-authored categories should
 * always map to one of these; unknown falls back to "normal". The table
 * is the policy knob — edits here reshape the long tail of memory.
 */
export const CATEGORY_DECAY: Record<string, DecayCurve> = {
  // Sacred — never decay
  core: "none",
  session_zero: "none",
  session_zero_voice: "none",
  // Very slow — relational bonds accumulate slowly
  relationship: "very_slow",
  // Slow — events, facts, location details matter for dozens of turns
  consequence: "slow",
  fact: "slow",
  npc_interaction: "slow",
  location: "slow",
  location_fact: "slow",
  narrative_beat: "slow",
  backstory: "slow",
  lore: "slow",
  faction_fact: "slow",
  // Normal — quest + world_state + events decay at baseline
  quest: "normal",
  world_state: "normal",
  event: "normal",
  npc_state: "normal",
  ability_fact: "normal",
  // Fast — character_state (hunger, fatigue, current location) expires quickly
  character_state: "fast",
  // Very fast — one-episode summaries decay quickly so they don't dominate
  // recall once the episode is out of working memory
  episode: "very_fast",
};

/**
 * Resolve the decay curve for a category, defaulting to "normal" when
 * Chronicler invents a new category we haven't mapped yet.
 */
export function curveFor(category: string): DecayCurve {
  return CATEGORY_DECAY[category] ?? "normal";
}

/**
 * Boost-on-access deltas per category. Applied when `search_memory`
 * surfaces a candidate — keeps frequently-relevant memories hot.
 */
export const BOOST_ON_ACCESS: { relationship: number; default: number } = {
  relationship: 30,
  default: 20,
};

/**
 * Static boost applied during retrieval ranking (M4-gated — wired in the
 * semantic retrieval runtime once the embedder decision lands). Scaffolded
 * here so callers can reference the same constants now.
 */
export const STATIC_BOOST: {
  session_zero: number;
  plot_critical: number;
  episode: number;
} = {
  session_zero: 0.3,
  plot_critical: 0.3,
  episode: 0.15,
};

export interface MemoryFlags {
  plot_critical?: boolean;
  milestone_relationship?: boolean;
  boost_priority?: number;
}

/**
 * Compute the heat floor for a memory given its flags. Plot-critical
 * items can't decay below their current value (stored heat); relationship
 * milestones floor at 40. Default floor is 1 (heat can't reach 0 — retains
 * a trace so the memory never becomes invisible to retrieval).
 */
export function heatFloor(flags: MemoryFlags | null | undefined, currentHeat: number): number {
  if (flags?.plot_critical) return currentHeat;
  if (flags?.milestone_relationship) return 40;
  return 1;
}

/** Firestore commits cap each batch at 500 writes. Stay one short to leave
 * headroom for the rare edge case where a future caller wants to bundle
 * an extra op into the same batch. */
const BATCH_LIMIT = 500;

/**
 * Run decay on every memory in a campaign, advancing their heat to
 * reflect turn distance from `currentTurn`. Called from Chronicler's
 * end-of-pass (or manually via maintenance script).
 *
 * Postgres-era implementation issued a single UPDATE with an inline
 * CASE expression and a GREATEST(floor, FLOOR(heat * mult^delta)) clamp —
 * one round-trip, server-side math. Firestore has no equivalent, so we
 * read every memory, compute the new heat in JS using the same formula,
 * then commit batched updates (500-doc cap per batch). For typical M1
 * campaign sizes (low hundreds of memories) one read pass + one batch
 * commit is fine; if N > 10k this should move to a background job.
 */
export async function decayHeat(
  firestore: Firestore,
  campaignId: string,
  currentTurn: number,
): Promise<{ rowsAffected: number }> {
  const memoriesRef = firestore
    .collection(COL.campaigns)
    .doc(campaignId)
    .collection(CAMPAIGN_SUB.semanticMemories);
  const snap = await memoriesRef.get();
  if (snap.empty) return { rowsAffected: 0 };

  let rowsAffected = 0;
  let batch = firestore.batch();
  let pending = 0;

  for (const doc of snap.docs) {
    const data = doc.data() as {
      category?: string;
      heat?: number;
      turnNumber?: number;
      flags?: MemoryFlags | null;
    };
    const heat = typeof data.heat === "number" ? data.heat : 0;
    const turnNumber = typeof data.turnNumber === "number" ? data.turnNumber : currentTurn;
    const category = data.category ?? "";
    const flags = data.flags ?? null;

    // delta_turns = max(0, currentTurn - turn_number). New memories
    // (same turn) don't decay on their insert-turn (mult^0 = 1).
    const delta = Math.max(0, currentTurn - turnNumber);
    const multiplier = DECAY_CURVES[curveFor(category)];
    const decayed = Math.floor(heat * multiplier ** delta);
    const floor = heatFloor(flags, heat);
    const newHeat = Math.max(floor, decayed);

    if (newHeat === heat) continue;

    batch.update(doc.ref, { heat: newHeat });
    pending += 1;
    rowsAffected += 1;

    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch = firestore.batch();
      pending = 0;
    }
  }

  if (pending > 0) {
    await batch.commit();
  }

  return { rowsAffected };
}

/**
 * Boost heat on a specific memory that was just accessed via retrieval.
 * Called from `search_memory` after returning the top-k so the rows
 * that proved relevant stay hot.
 *
 * Postgres clamped via SQL `LEAST(100, heat + boost)` server-side. Firestore
 * `FieldValue.increment` cannot enforce a ceiling atomically; the next
 * decay pass reins runaway values back down (heat is rebuilt from the
 * stored value each turn anyway). For M0.5 the unbounded increment is
 * acceptable — the floor invariant ([0, *)) is what retrieval ranking
 * actually depends on, and it holds.
 */
export async function boostHeatOnAccess(
  firestore: Firestore,
  campaignId: string,
  memoryId: string,
  category: string,
): Promise<void> {
  const boost =
    category === "relationship" ? BOOST_ON_ACCESS.relationship : BOOST_ON_ACCESS.default;
  const ref = firestore
    .collection(COL.campaigns)
    .doc(campaignId)
    .collection(CAMPAIGN_SUB.semanticMemories)
    .doc(memoryId);
  await ref.set({ heat: FieldValue.increment(boost) }, { merge: true });
}
