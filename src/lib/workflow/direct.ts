/**
 * Director firing workflow. Runs Director on three triggers (per
 * ROADMAP §5.5 + M4 deliverable list):
 *
 *   - "startup": campaign just transitioned to phase=playing. Director
 *     authors the initial arc plan from the OpeningStatePackage.
 *   - "session_boundary": first turn of a new session. Director rolls
 *     forward the arc plan with last-session signals.
 *   - "hybrid": every 3+ turns when epicness >= 0.6, KA's last beat
 *     warrants a director consult to nudge pacing / voice / arc.
 *
 * The workflow:
 *   1. Reads the campaign's recent state (turns, seeds, voice patterns,
 *      arc plan).
 *   2. Calls `runDirector` with the trigger + inputs.
 *   3. Persists outputs to Firestore: arcPlanHistory, voicePatterns,
 *      directorNotes, foreshadowingSeeds (PLANTED / RESOLVED diff),
 *      spotlightDebt.
 *
 * Idempotency: a `directorRunAt:{trigger}:{turnNumber}` field on the
 * campaign doc prevents duplicate runs from racing post-turn workers
 * (Next's `after()` doesn't dedup if the route handler retries).
 */
import { type DirectorInput, type DirectorOutput, runDirector } from "@/lib/agents/director";
import { type AgentLogger, defaultLogger } from "@/lib/agents/types";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import type { AidmSpanHandle } from "@/lib/tools";
import { resolveModelContext } from "@/lib/workflow/turn";
import { FieldValue } from "firebase-admin/firestore";

export interface DirectTurnInput {
  campaignId: string;
  userId: string;
  /** Which trigger fires this run. */
  trigger: DirectorInput["trigger"];
  /** Current turn number. 0 for startup. */
  turnNumber: number;
  /** Latest epicness signal (hybrid trigger only). */
  epicness?: number;
  /** Opening state package — required at startup. */
  openingStatePackage?: unknown;
}

export interface DirectTurnDeps {
  logger?: AgentLogger;
  trace?: AidmSpanHandle;
  recordPrompt?: (agentName: string, fingerprint: string) => void;
}

/**
 * Decision: should we fire Director for the hybrid trigger? Per
 * ROADMAP §5.2 — every 3+ turns AND epicness >= 0.6.
 */
export function shouldFireHybrid(turnNumber: number, epicness: number): boolean {
  if (turnNumber < 3) return false;
  if (turnNumber % 3 !== 0) return false;
  if (epicness < 0.6) return false;
  return true;
}

type DirectTurnOutcome = "ok" | "skipped" | "failed";

export async function directTurn(
  input: DirectTurnInput,
  deps: DirectTurnDeps = {},
): Promise<DirectTurnOutcome> {
  const logger = deps.logger ?? defaultLogger;
  const logContext = {
    campaignId: input.campaignId,
    userId: input.userId,
    turnNumber: input.turnNumber,
    trigger: input.trigger,
  };
  logger("info", "directTurn: start", logContext);

  const firestore = getFirebaseFirestore();
  const campaignRef = firestore.collection(COL.campaigns).doc(input.campaignId);

  // Idempotency — `directorRunAt:{trigger}:{turnNumber}` on the campaign
  // doc. Same shape as chronicler's idempotency marker.
  const idempotencyKey = `directorRunAt:${input.trigger}:${input.turnNumber}`;
  const campaignSnap = await campaignRef.get();
  if (!campaignSnap.exists) {
    logger("warn", "directTurn: campaign not found", logContext);
    return "failed";
  }
  const cd = campaignSnap.data();
  if (!cd || cd.ownerUid !== input.userId || cd.deletedAt !== null) {
    logger("warn", "directTurn: campaign access denied", logContext);
    return "failed";
  }
  if (cd[idempotencyKey]) {
    logger("info", "directTurn: already ran for this trigger+turn", logContext);
    return "skipped";
  }

  const modelContext = resolveModelContext(cd.settings, logger);

  // Pull recent turns (last 6 for context).
  const recentSnap = await campaignRef
    .collection(CAMPAIGN_SUB.turns)
    .orderBy("turnNumber", "desc")
    .limit(6)
    .get();
  const recentTurns = recentSnap.docs
    .map((d) => {
      const r = d.data();
      return {
        turn_number: typeof r.turnNumber === "number" ? r.turnNumber : 0,
        summary:
          typeof r.summary === "string"
            ? r.summary
            : typeof r.narrativeText === "string"
              ? r.narrativeText.slice(0, 240)
              : "",
        intent: r.intent,
      };
    })
    .reverse();

  // Active foreshadowing seeds.
  const seedsSnap = await campaignRef.collection(CAMPAIGN_SUB.foreshadowingSeeds).get();
  const activeSeeds = seedsSnap.docs
    .map((d) => {
      const r = d.data();
      return {
        id: d.id,
        name: typeof r.name === "string" ? r.name : "(unnamed)",
        status: (typeof r.status === "string" ? r.status : "PLANTED") as
          | "PLANTED"
          | "GROWING"
          | "CALLBACK"
          | "RESOLVED"
          | "ABANDONED"
          | "OVERDUE",
        age_turns:
          typeof r.plantedAtTurn === "number" ? Math.max(0, input.turnNumber - r.plantedAtTurn) : 0,
      };
    })
    .filter((s) => s.status !== "RESOLVED" && s.status !== "ABANDONED");

  // Current voice patterns (latest snapshot).
  const voiceSnap = await campaignRef
    .collection(CAMPAIGN_SUB.voicePatterns)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  const currentPatterns = voiceSnap.docs.flatMap((d) => {
    const r = d.data();
    return Array.isArray(r.patterns) ? (r.patterns as string[]) : [];
  });

  // Current arc plan (latest snapshot).
  const arcSnap = await campaignRef
    .collection(CAMPAIGN_SUB.arcPlanHistory)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  const currentArcPlan = arcSnap.docs[0]?.data().arcPlan ?? null;

  const directorInput: DirectorInput = {
    trigger: input.trigger,
    openingStatePackage: input.openingStatePackage,
    recentTurns,
    currentArcPlan,
    activeSeeds,
    currentVoicePatterns: { patterns: currentPatterns },
  };

  let output: DirectorOutput;
  try {
    output = await runDirector(directorInput, {
      modelContext,
      logger,
      trace: deps.trace,
      recordPrompt: deps.recordPrompt,
    });
  } catch (err) {
    logger("error", "directTurn: runDirector failed", {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }

  // Persist outputs.
  const batch = firestore.batch();
  const now = FieldValue.serverTimestamp();

  batch.set(campaignRef.collection(CAMPAIGN_SUB.arcPlanHistory).doc(), {
    arcPlan: output.arcPlan,
    trigger: input.trigger,
    turnNumber: input.turnNumber,
    createdAt: now,
  });
  if (output.voicePatterns.patterns.length > 0) {
    batch.set(campaignRef.collection(CAMPAIGN_SUB.voicePatterns).doc(), {
      patterns: output.voicePatterns.patterns,
      trigger: input.trigger,
      turnNumber: input.turnNumber,
      createdAt: now,
    });
  }
  for (const note of output.directorNotes) {
    batch.set(campaignRef.collection(CAMPAIGN_SUB.directorNotes).doc(), {
      content: note,
      turnNumber: input.turnNumber,
      createdAt: now,
    });
  }
  for (const plant of output.foreshadowing.plant) {
    batch.set(campaignRef.collection(CAMPAIGN_SUB.foreshadowingSeeds).doc(), {
      name: plant.name,
      description: plant.description,
      status: "PLANTED",
      payoffWindowMin: plant.payoff_window_min,
      payoffWindowMax: plant.payoff_window_max,
      dependsOn: plant.depends_on,
      conflictsWith: plant.conflicts_with,
      plantedAtTurn: input.turnNumber,
      createdAt: now,
    });
  }
  for (const retire of output.foreshadowing.retire) {
    const ref = campaignRef.collection(CAMPAIGN_SUB.foreshadowingSeeds).doc(retire.id);
    batch.set(
      ref,
      { status: retire.status, retiredReason: retire.reason, retiredAtTurn: input.turnNumber },
      { merge: true },
    );
  }
  if (Object.keys(output.spotlightDebt.per_npc).length > 0) {
    batch.set(campaignRef.collection(CAMPAIGN_SUB.spotlightDebt).doc(), {
      perNpc: output.spotlightDebt.per_npc,
      turnNumber: input.turnNumber,
      createdAt: now,
    });
  }

  // Stamp idempotency on the campaign doc.
  batch.set(campaignRef, { [idempotencyKey]: now }, { merge: true });

  try {
    await batch.commit();
  } catch (err) {
    logger("error", "directTurn: persistence failed", {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }

  logger("info", "directTurn: ok", {
    ...logContext,
    plantedSeeds: output.foreshadowing.plant.length,
    retiredSeeds: output.foreshadowing.retire.length,
    voicePatterns: output.voicePatterns.patterns.length,
    directorNotes: output.directorNotes.length,
  });
  return "ok";
}
