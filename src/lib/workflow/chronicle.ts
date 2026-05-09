import { type ArcTrigger, type ChroniclerDeps, runChronicler } from "@/lib/agents/chronicler";
import { incrementCostLedger } from "@/lib/budget";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
// Firestore in tests is provided directly via deps.firestore. The runtime
// path is the chronicle dispatch from the SSE route handler, which goes
// through tryGetFirestore (test env has no project credentials).
function tryGetFirestore(): Firestore | undefined {
  if (process.env.NODE_ENV === "test") return undefined;
  try {
    return getFirebaseFirestore();
  } catch {
    return undefined;
  }
}
import { decayHeat } from "@/lib/memory/decay";
import type { AidmToolContext } from "@/lib/tools";
import { resolveModelContext } from "./turn";

/**
 * Chronicler wrapper — FIFO-per-campaign serialization + idempotency guard +
 * error swallow. Called from the SSE route handler's `after()` callback so
 * the user's done event has already flushed before Chronicler starts.
 *
 * Design decisions (M0.5 Firestore migration):
 *
 *   1. **Firestore-doc mutex.** The Postgres advisory-lock approach
 *      (`pg_advisory_lock(int4, int4)`) doesn't have a Firestore
 *      equivalent. We use a flag on the campaign doc:
 *        - `chroniclerInFlight: boolean`
 *        - `chroniclerStartedAt: timestamp`
 *      A second Chronicler invocation that finds `inFlight === true`
 *      and `now - startedAt < 60s` returns early with `skipped_concurrent`.
 *      This is coarser than pg_advisory_lock (which would queue) but
 *      preserves the FIFO-per-campaign invariant for the cases that
 *      actually matter — back-to-back turns chronicling concurrently.
 *      Stale-flag GC happens on the next chronicle run when the
 *      timeout elapses.
 *
 *   2. **Idempotency.** `turns/{turnId}.chronicledAt == null` is the
 *      guard. If a retried Chronicler finds the timestamp set, it
 *      returns early. This protects non-idempotent writes
 *      (record_relationship_event append-only;
 *      adjust_spotlight_debt incremental) from double-application.
 *
 *   3. **Error swallow.** Chronicler failures don't retroactively
 *      fail the turn — the player already saw the narrative. We log
 *      the error + leave `chronicledAt` null (so a future retry could
 *      run if we add an admin endpoint). The turn data itself is
 *      already committed.
 */

const CHRONICLER_LOCK_TIMEOUT_MS = 60_000;

export interface ChronicleTurnInput {
  turnId: string;
  campaignId: string;
  userId: string;
  turnNumber: number;
  playerMessage: string;
  narrative: string;
  intent: import("@/lib/types/turn").IntentOutput;
  outcome: import("@/lib/types/turn").OutcomeOutput | null;
  /**
   * Arc-level writes gating. Caller decides. M1 heuristic (in route
   * handler): `"session_boundary"` if turn is first/last of a session,
   * `"hybrid"` if turn.intent.epicness >= 0.6 and turnNumber % 3 === 0,
   * else `null`. Lands in Commit 7.4's wiring spot.
   */
  arcTrigger: ArcTrigger;
}

export interface ChronicleTurnDeps extends ChroniclerDeps {
  /** Firestore handle. Tests inject a fake; production resolves via tryGetFirestore. */
  firestore?: Firestore;
}

/**
 * Acquire the chronicler mutex on the campaign doc. Returns `true` if
 * we now hold the lock (the doc didn't have an active flag, or its
 * timestamp was stale). Returns `false` if a recent in-flight
 * chronicler is still running.
 *
 * Uses a transaction so two simultaneous chronicleTurn invocations
 * race deterministically — exactly one observes `inFlight === false`
 * (or stale timestamp) and proceeds; the other backs off.
 */
async function acquireChroniclerLock(firestore: Firestore, campaignId: string): Promise<boolean> {
  const ref = firestore.collection(COL.campaigns).doc(campaignId);
  return await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data() ?? {};
    const inFlight = data.chroniclerInFlight === true;
    // Timestamp can be a Firestore Timestamp (read path) or undefined.
    const startedRaw = data.chroniclerStartedAt;
    const startedAtMs =
      startedRaw && typeof (startedRaw as { toMillis?: () => number }).toMillis === "function"
        ? (startedRaw as { toMillis: () => number }).toMillis()
        : startedRaw instanceof Date
          ? startedRaw.getTime()
          : 0;
    const ageMs = Date.now() - startedAtMs;
    if (inFlight && ageMs < CHRONICLER_LOCK_TIMEOUT_MS) {
      return false;
    }
    // Either flag was clear, or the timestamp is stale → claim the lock.
    tx.set(
      ref,
      {
        chroniclerInFlight: true,
        chroniclerStartedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return true;
  });
}

async function releaseChroniclerLock(firestore: Firestore, campaignId: string): Promise<void> {
  const ref = firestore.collection(COL.campaigns).doc(campaignId);
  await ref.set({ chroniclerInFlight: false }, { merge: true });
}

/**
 * Run Chronicler for a persisted turn. Safe to call N times — the
 * idempotency guard skips reruns. Throws never; logs and returns
 * silently on failure so the caller's `after()` callback exits clean.
 *
 * Returns a status tag for observability + tests.
 */
export async function chronicleTurn(
  input: ChronicleTurnInput,
  deps: ChronicleTurnDeps,
): Promise<"ok" | "already_chronicled" | "failed" | "skipped_non_continue" | "skipped_concurrent"> {
  const logger = deps.logger ?? ((level, msg, meta) => console.log(`[${level}] ${msg}`, meta));
  // Correlation fields attached to every chronicler log so a failure
  // joins up with the originating turn's stdout lines.
  const logContext = {
    campaignId: input.campaignId,
    userId: input.userId,
    turnNumber: input.turnNumber,
  };
  logger("info", "chronicleTurn: start", { ...logContext, turnId: input.turnId });

  const firestore = deps.firestore ?? tryGetFirestore();
  if (!firestore) {
    logger("warn", "chronicleTurn: firestore unavailable; skipping", { ...logContext });
    return "failed";
  }

  const acquired = await acquireChroniclerLock(firestore, input.campaignId);
  if (!acquired) {
    logger("info", "chronicleTurn: another run in flight; skipping", { ...logContext });
    return "skipped_concurrent";
  }
  try {
    // Idempotency check: was this turn already chronicled?
    const turnRef = firestore
      .collection(COL.campaigns)
      .doc(input.campaignId)
      .collection(CAMPAIGN_SUB.turns)
      .doc(input.turnId);
    const turnSnap = await turnRef.get();
    if (!turnSnap.exists) {
      logger("warn", "chronicleTurn: turn doc not found", {
        ...logContext,
        turnId: input.turnId,
      });
      return "failed";
    }
    const turnData = turnSnap.data() ?? {};
    if (turnData.chronicledAt != null) {
      logger("info", "chronicleTurn: already chronicled, skipping", {
        ...logContext,
        turnId: input.turnId,
      });
      return "already_chronicled";
    }

    // Load the campaign fresh for modelContext. Chronicler-time is
    // post-turn, so a settings change during the turn is fine to pick
    // up on the background pass.
    const campaignSnap = await firestore.collection(COL.campaigns).doc(input.campaignId).get();
    if (!campaignSnap.exists) {
      logger("warn", "chronicleTurn: campaign not found (deleted or transferred?)", {
        ...logContext,
      });
      return "failed";
    }
    const campaignData = campaignSnap.data();
    if (
      !campaignData ||
      campaignData.ownerUid !== input.userId ||
      campaignData.deletedAt !== null
    ) {
      logger("warn", "chronicleTurn: campaign access denied", { ...logContext });
      return "failed";
    }

    // resolveModelContext always returns a config (falls back to
    // anthropicFallbackConfig internally on parse failure / missing fields).
    const modelContext = resolveModelContext(campaignData.settings, logger);

    const toolContext: AidmToolContext = {
      campaignId: input.campaignId,
      userId: input.userId,
      firestore,
      trace: deps.trace,
      logger,
      logContext,
    };

    const chroniclerResult = await runChronicler(
      {
        turnNumber: input.turnNumber,
        playerMessage: input.playerMessage,
        narrative: input.narrative,
        intent: input.intent,
        outcome: input.outcome,
        arcTrigger: input.arcTrigger,
        modelContext,
        toolContext,
      },
      {
        logger: deps.logger,
        logContext,
        trace: deps.trace,
        recordPrompt: deps.recordPrompt,
        queryFn: deps.queryFn,
      },
    );

    // Run heat decay post-Chronicler so any memories Chronicler just
    // wrote at the current turn don't decay on their insert-turn
    // (Math.max(0, currentTurn - turn_number) = 0 → multiplier^0 = 1).
    // Earlier memories get their turn-distance multiplier applied.
    // Runs best-effort: a decay failure is logged but doesn't fail the
    // chronicling pass, which has already been stamped-idempotent.
    try {
      const decayResult = await decayHeat(firestore, input.campaignId, input.turnNumber);
      logger("info", "chronicleTurn: decayHeat ok", {
        ...logContext,
        rowsAffected: decayResult.rowsAffected,
      });
    } catch (err) {
      logger("warn", "chronicleTurn: decayHeat failed (non-fatal)", {
        ...logContext,
        turnId: input.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Chronicler cost roll-up (Commit 9). Agent SDK returns the full
    // session cost including any consultant subagent (RelationshipAnalyzer).
    // Adds into the turn doc's costUsd + user_cost_ledger, both safe to
    // call with 0 (no-op updates).
    const chroniclerCost = chroniclerResult.costUsd ?? 0;
    if (chroniclerCost > 0) {
      // Numeric increment preserves the running total across the chronicle
      // pass. costUsd is stored as a number in Firestore (Postgres NUMERIC
      // gave us 6-decimal precision; floats are fine for cost roll-up at
      // M0.5 — billing reconciliation, not finance).
      await turnRef.set(
        {
          costUsd: FieldValue.increment(chroniclerCost),
          chronicledAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      try {
        await incrementCostLedger(input.userId, chroniclerCost);
      } catch (err) {
        // Ledger-increment failure must not fail the chronicling pass —
        // the per-user budget gate degrades to conservative (gate still
        // fires on the PRE-PASS/KA cost written earlier) rather than
        // retroactively failing a turn that narratively landed.
        logger("warn", "chronicleTurn: incrementCostLedger failed (non-fatal)", {
          ...logContext,
          turnId: input.turnId,
          chroniclerCost,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // No cost — just stamp chronicledAt.
      await turnRef.set({ chronicledAt: FieldValue.serverTimestamp() }, { merge: true });
    }

    logger("info", "chronicleTurn: ok", {
      ...logContext,
      turnId: input.turnId,
      chroniclerCostUsd: chroniclerResult.costUsd,
      chroniclerTotalMs: chroniclerResult.totalMs,
      chroniclerToolCallCount: chroniclerResult.toolCallCount,
      chroniclerStopReason: chroniclerResult.stopReason,
    });
    return "ok";
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger("error", "chronicleTurn: failed (swallowed; turn state unchanged)", {
      ...logContext,
      turnId: input.turnId,
      error: errMsg,
    });
    return "failed";
  } finally {
    // Release the lock even on error so the next turn's Chronicler
    // can proceed.
    await releaseChroniclerLock(firestore, input.campaignId).catch(() => {
      /* best-effort */
    });
  }
}

/**
 * Heuristic for arc-level write trigger. Called by the SSE route handler
 * to decide whether to pass `arcTrigger: "hybrid"` vs `null`.
 *
 * M1 rule:
 *   - Epicness >= 0.6 AND turnNumber % 3 === 0 → "hybrid"
 *   - Otherwise null
 * Session-boundary detection lands when session-tracking does (post-M1);
 * this function conservatively never returns "session_boundary" at M1.
 */
export function computeArcTrigger(intentEpicness: number, turnNumber: number): ArcTrigger {
  if (intentEpicness >= 0.6 && turnNumber % 3 === 0) return "hybrid";
  return null;
}
