/**
 * State snapshot artifacts (M7).
 *
 * Every N turns, write a versioned snapshot of the campaign's playable
 * state to `campaigns/{id}/openingStatePackages` (re-using the OSP
 * collection — packageType discriminates between session-zero handoff
 * packages and mid-campaign snapshots).
 *
 * Snapshots enable:
 *   - Replay-from-artifact testing (start from snapshot N, replay
 *     turns N+1..M, compare narrative).
 *   - Session-boundary detection at M7 (compare current state to last
 *     snapshot to gauge how much has changed since the previous
 *     session).
 *   - Disaster recovery (if Firestore loses data, last snapshot is
 *     the recovery point).
 */
import { type AgentLogger, defaultLogger } from "@/lib/agents/types";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";

const SNAPSHOT_INTERVAL_TURNS = 10;

/** True when this turn should trigger a snapshot write. */
export function shouldSnapshot(turnNumber: number): boolean {
  if (turnNumber <= 0) return false;
  return turnNumber % SNAPSHOT_INTERVAL_TURNS === 0;
}

export interface SnapshotInput {
  campaignId: string;
  userId: string;
  turnNumber: number;
}

export interface SnapshotDeps {
  logger?: AgentLogger;
}

type SnapshotOutcome = "ok" | "skipped" | "failed";

export async function writeStateSnapshot(
  input: SnapshotInput,
  deps: SnapshotDeps = {},
): Promise<SnapshotOutcome> {
  const logger = deps.logger ?? defaultLogger;
  const logContext = {
    campaignId: input.campaignId,
    userId: input.userId,
    turnNumber: input.turnNumber,
  };

  const firestore = getFirebaseFirestore();
  const campaignRef = firestore.collection(COL.campaigns).doc(input.campaignId);

  const campaignSnap = await campaignRef.get();
  if (!campaignSnap.exists) {
    logger("warn", "snapshot: campaign not found", logContext);
    return "failed";
  }
  const cd = campaignSnap.data();
  if (!cd || cd.ownerUid !== input.userId || cd.deletedAt !== null) {
    logger("warn", "snapshot: campaign access denied", logContext);
    return "failed";
  }

  // Idempotency — one snapshot per turn boundary.
  const idempotencyKey = `snapshotAt:${input.turnNumber}`;
  if (cd[idempotencyKey]) {
    return "skipped";
  }

  // Pull the latest state (character + active context blocks + recent
  // semantic memories + arc plan). Snapshot is a flat readable JSON
  // bundle, not a wire format.
  const [characterSnap, contextSnap, semanticSnap, arcSnap] = await Promise.all([
    campaignRef.collection(CAMPAIGN_SUB.characters).limit(5).get(),
    campaignRef
      .collection(CAMPAIGN_SUB.contextBlocks)
      .where("status", "==", "active")
      .limit(50)
      .get(),
    campaignRef.collection(CAMPAIGN_SUB.semanticMemories).orderBy("heat", "desc").limit(40).get(),
    campaignRef.collection(CAMPAIGN_SUB.arcPlanHistory).orderBy("createdAt", "desc").limit(1).get(),
  ]);

  const snapshot = {
    schema_version: "snapshot.v1",
    turn_number: input.turnNumber,
    campaign_settings: cd.settings ?? null,
    characters: characterSnap.docs.map((d) => ({ id: d.id, data: d.data() })),
    active_context_blocks: contextSnap.docs.map((d) => ({ id: d.id, data: d.data() })),
    semantic_memory_top: semanticSnap.docs.map((d) => ({
      id: d.id,
      data: (() => {
        const r = d.data();
        // Skip embedding to keep the doc small (768 floats per row).
        const { embedding: _e, ...rest } = r as Record<string, unknown>;
        return rest;
      })(),
    })),
    arc_plan: arcSnap.docs[0]?.data().arcPlan ?? null,
  };

  const now = FieldValue.serverTimestamp();
  try {
    await firestore.runTransaction(async (tx) => {
      tx.create(campaignRef.collection(CAMPAIGN_SUB.openingStatePackages).doc(), {
        packageType: "snapshot",
        turnNumber: input.turnNumber,
        content: snapshot,
        createdAt: now,
      });
      tx.set(campaignRef, { [idempotencyKey]: now }, { merge: true });
    });
  } catch (err) {
    logger("error", "snapshot: persist failed", {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }

  logger("info", "snapshot: ok", logContext);
  return "ok";
}
