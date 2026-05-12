/**
 * Foreshadowing lifecycle automation (M6).
 *
 * Director plants seeds; Chronicler retires them; this workflow
 * handles the automatic age-based transitions between those two
 * endpoints:
 *
 *   PLANTED  → GROWING   (age >= payoff_window_min)
 *   GROWING  → CALLBACK  (KA references it — detection deferred;
 *                         Chronicler is the canonical mover today)
 *   *        → OVERDUE   (age > payoff_window_max AND not yet RESOLVED)
 *
 * Runs as a post-turn `after()` worker — same pattern as Chronicler /
 * Director. Idempotent: a `foreshadowLifecycleAt:{turnNumber}` field
 * on the campaign doc dedups concurrent runs.
 *
 * Convergence detection: when two GROWING seeds' payoff windows
 * overlap with the current turn, a directorNotes entry is written
 * so Director's next hybrid invocation has the signal.
 */
import { type AgentLogger, defaultLogger } from "@/lib/agents/types";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";

export type ForeshadowStatus =
  | "PLANTED"
  | "GROWING"
  | "CALLBACK"
  | "RESOLVED"
  | "ABANDONED"
  | "OVERDUE";

export interface ForeshadowSeedRow {
  id: string;
  name: string;
  status: ForeshadowStatus;
  payoffWindowMin: number;
  payoffWindowMax: number;
  plantedAtTurn: number;
}

export interface LifecycleTransition {
  seedId: string;
  from: ForeshadowStatus;
  to: ForeshadowStatus;
  reason: string;
}

/**
 * Pure decision: given a seed's status + age, decide whether it
 * transitions on this turn. Returns null when no transition.
 *
 * `age = turnNumber - seed.plantedAtTurn`.
 */
export function decideLifecycle(
  seed: ForeshadowSeedRow,
  turnNumber: number,
): LifecycleTransition | null {
  const age = Math.max(0, turnNumber - seed.plantedAtTurn);
  // Resolved + Abandoned are terminal.
  if (seed.status === "RESOLVED" || seed.status === "ABANDONED") return null;
  // Already overdue and still un-retired — leave it; Director can
  // re-prioritize on the next hybrid pass.
  if (seed.status === "OVERDUE") return null;
  // Overdue check applies to PLANTED / GROWING / CALLBACK alike.
  if (age > seed.payoffWindowMax) {
    return {
      seedId: seed.id,
      from: seed.status,
      to: "OVERDUE",
      reason: `age ${age} > payoffWindowMax ${seed.payoffWindowMax}`,
    };
  }
  // Maturation: PLANTED → GROWING once the payoff window opens.
  if (seed.status === "PLANTED" && age >= seed.payoffWindowMin) {
    return {
      seedId: seed.id,
      from: "PLANTED",
      to: "GROWING",
      reason: `age ${age} entered payoff window [${seed.payoffWindowMin}, ${seed.payoffWindowMax}]`,
    };
  }
  return null;
}

/**
 * Detect convergence points: GROWING seeds whose payoff windows
 * overlap with the current turn. Returns the IDs.
 */
export function detectConvergence(seeds: ForeshadowSeedRow[], turnNumber: number): string[] {
  const overlapping = seeds.filter((s) => {
    if (s.status !== "GROWING") return false;
    const age = Math.max(0, turnNumber - s.plantedAtTurn);
    return age >= s.payoffWindowMin && age <= s.payoffWindowMax;
  });
  // Convergence is meaningful only when 2+ seeds want the same window.
  return overlapping.length >= 2 ? overlapping.map((s) => s.id) : [];
}

export interface ForeshadowTickInput {
  campaignId: string;
  userId: string;
  turnNumber: number;
}

export interface ForeshadowTickDeps {
  logger?: AgentLogger;
}

type ForeshadowOutcome = "ok" | "skipped" | "failed";

export async function foreshadowTick(
  input: ForeshadowTickInput,
  deps: ForeshadowTickDeps = {},
): Promise<ForeshadowOutcome> {
  const logger = deps.logger ?? defaultLogger;
  const logContext = {
    campaignId: input.campaignId,
    userId: input.userId,
    turnNumber: input.turnNumber,
  };

  const firestore = getFirebaseFirestore();
  const campaignRef = firestore.collection(COL.campaigns).doc(input.campaignId);

  const idempotencyKey = `foreshadowLifecycleAt:${input.turnNumber}`;
  const campaignSnap = await campaignRef.get();
  if (!campaignSnap.exists) {
    logger("warn", "foreshadowTick: campaign not found", logContext);
    return "failed";
  }
  const cd = campaignSnap.data();
  if (!cd || cd.ownerUid !== input.userId || cd.deletedAt !== null) {
    logger("warn", "foreshadowTick: campaign access denied", logContext);
    return "failed";
  }
  if (cd[idempotencyKey]) {
    return "skipped";
  }

  const seedsSnap = await campaignRef.collection(CAMPAIGN_SUB.foreshadowingSeeds).get();
  const seeds: ForeshadowSeedRow[] = seedsSnap.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id,
      name: typeof r.name === "string" ? r.name : "(unnamed)",
      status: (typeof r.status === "string" ? r.status : "PLANTED") as ForeshadowStatus,
      payoffWindowMin: typeof r.payoffWindowMin === "number" ? r.payoffWindowMin : 1,
      payoffWindowMax: typeof r.payoffWindowMax === "number" ? r.payoffWindowMax : 10,
      plantedAtTurn: typeof r.plantedAtTurn === "number" ? r.plantedAtTurn : 0,
    };
  });

  const transitions: LifecycleTransition[] = [];
  for (const seed of seeds) {
    const t = decideLifecycle(seed, input.turnNumber);
    if (t) transitions.push(t);
  }

  const convergenceIds = detectConvergence(seeds, input.turnNumber);

  if (transitions.length === 0 && convergenceIds.length === 0) {
    await campaignRef.set({ [idempotencyKey]: FieldValue.serverTimestamp() }, { merge: true });
    return "ok";
  }

  const batch = firestore.batch();
  const now = FieldValue.serverTimestamp();
  for (const t of transitions) {
    const ref = campaignRef.collection(CAMPAIGN_SUB.foreshadowingSeeds).doc(t.seedId);
    batch.set(
      ref,
      {
        status: t.to,
        lastTransitionTurn: input.turnNumber,
        lastTransitionReason: t.reason,
      },
      { merge: true },
    );
  }
  if (convergenceIds.length > 0) {
    batch.set(campaignRef.collection(CAMPAIGN_SUB.directorNotes).doc(), {
      content: `Foreshadowing convergence: seeds [${convergenceIds.join(", ")}] all want payoff on or near turn ${input.turnNumber}. Director should pick one to land, defer the others.`,
      turnNumber: input.turnNumber,
      kind: "foreshadow_convergence",
      createdAt: now,
    });
  }
  batch.set(campaignRef, { [idempotencyKey]: now }, { merge: true });

  try {
    await batch.commit();
  } catch (err) {
    logger("error", "foreshadowTick: persistence failed", {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }

  logger("info", "foreshadowTick: ok", {
    ...logContext,
    transitions: transitions.length,
    convergence: convergenceIds.length,
  });
  return "ok";
}
