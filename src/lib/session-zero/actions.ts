"use server";

import { getCurrentUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { revalidatePath } from "next/cache";
import { ensureSessionZeroCampaign } from "./ensure-campaign";

/**
 * Server actions surfacing Session Zero lifecycle controls beyond the
 * conductor's tool calls:
 *
 *   - `redoSessionZero` — restart from scratch on a campaign whose
 *     player isn't yet committed. Eligible when the campaign is in
 *     a session-zero phase, OR is `playing` but no gameplay turns
 *     have fired (the conductor's stub is still the only narrative).
 *   - `abandonCampaign` — soft-delete (deletedAt = serverTimestamp).
 *     Reachable from /campaigns; reversible via Firestore admin if
 *     the player regrets it within the 14-day archival window.
 *
 * Both actions are caller-authenticated via `getCurrentUser` and
 * authz-checked against `ownerUid`. Failures return a structured
 * `{ ok: false, code, message }` rather than throwing — Next.js
 * server actions prefer this shape for client-side rendering.
 */

export type ActionResult<TData = undefined> =
  | { ok: true; data?: TData }
  | { ok: false; code: string; message: string };

const NOT_OWNED = {
  ok: false as const,
  code: "campaign_not_found",
  message: "Campaign not found or not yours.",
};

/**
 * Soft-delete a campaign. The doc stays in Firestore but every list
 * query filters by `deletedAt == null` so the campaign disappears
 * from the UI. The 14-day archive cron (M2.5 follow-up) will hard-
 * delete after grace.
 */
export async function abandonCampaign(campaignId: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, code: "unauthenticated", message: "Please sign in again." };

  const firestore = getFirebaseFirestore();
  const ref = firestore.collection(COL.campaigns).doc(campaignId);
  const snap = await ref.get();
  if (!snap.exists) return NOT_OWNED;
  const cd = snap.data();
  if (!cd || cd.ownerUid !== user.id || cd.deletedAt !== null) return NOT_OWNED;

  await ref.set({ deletedAt: FieldValue.serverTimestamp() }, { merge: true });
  revalidatePath("/campaigns");
  return { ok: true };
}

/**
 * Redo Session Zero for a campaign whose player hasn't committed to
 * the world yet. Soft-deletes the prior campaign, creates a fresh
 * one with a `supersedes` pointer for diagnostics, and returns the
 * new campaignId so the caller can navigate to `/sz/{newId}`.
 *
 * Eligibility check fires server-side so the affordance can't be
 * spoofed by a crafted POST. If a player has already played even one
 * gameplay turn, `redo` returns `not_eligible` — at that point the
 * world is shared between them and KA, and a redo would orphan
 * commitments KA may still reference.
 */
export async function redoSessionZero(
  campaignId: string,
): Promise<ActionResult<{ newCampaignId: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, code: "unauthenticated", message: "Please sign in again." };

  const firestore = getFirebaseFirestore();
  const ref = firestore.collection(COL.campaigns).doc(campaignId);
  const snap = await ref.get();
  if (!snap.exists) return NOT_OWNED;
  const cd = snap.data();
  if (!cd || cd.ownerUid !== user.id || cd.deletedAt !== null) return NOT_OWNED;

  const phase = typeof cd.phase === "string" ? cd.phase : "";
  const isSzPhase = phase === "session_zero" || phase === "sz";
  let isPreFirstTurnPlaying = false;
  if (phase === "playing") {
    const turnsSnap = await ref.collection(CAMPAIGN_SUB.turns).limit(1).get();
    isPreFirstTurnPlaying = turnsSnap.empty;
  }
  if (!isSzPhase && !isPreFirstTurnPlaying) {
    return {
      ok: false,
      code: "not_eligible",
      message:
        "Redo is only available before the first gameplay turn. Once the story has started, " +
        "the world is shared with KA and a redo would orphan commitments.",
    };
  }

  // Soft-delete the prior campaign FIRST so `ensureSessionZeroCampaign`'s
  // find-or-create doesn't pick it back up. The SZ doc phase isn't
  // touched — a future archive scrub can still distinguish
  // "abandoned mid-conductor" from "abandoned post-finalize" by
  // reading the SZ doc.
  await ref.set(
    {
      deletedAt: FieldValue.serverTimestamp(),
      supersededAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const fresh = await ensureSessionZeroCampaign(firestore, user.id);
  // Stamp the supersede pointer on the new campaign for diagnostics.
  await firestore
    .collection(COL.campaigns)
    .doc(fresh.campaignId)
    .set({ supersedes: campaignId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  revalidatePath("/campaigns");
  return { ok: true, data: { newCampaignId: fresh.campaignId } };
}
