import type { AppUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { seedBebopCampaign } from "./bebop";

/**
 * Lazy upsert of the user doc + Bebop demo campaign. Invoked from
 * POST /api/auth/session right after the ID token verifies, so the
 * player who just signed up lands on /campaigns with something to
 * play immediately.
 *
 * Both operations are idempotent:
 *   - users/{uid}: set merge (creates the doc on first call, no-ops on
 *     repeat calls; never overwrites the spending cap if already set).
 *   - seedBebopCampaign: upserts profile by slug, skips campaign
 *     creation if one with BEBOP_CAMPAIGN_NAME already exists.
 *
 * Cost: ~3 Firestore reads on the warm path (user doc + profile lookup
 * + campaign existence check). Sign-in latency, not turn-time hot path.
 */
export async function ensureUserSeeded(user: AppUser): Promise<void> {
  if (!user.email) return;
  const db = getFirebaseFirestore();
  const userRef = db.collection(COL.users).doc(user.id);
  const snap = await userRef.get();
  if (!snap.exists) {
    await userRef.set({
      id: user.id,
      email: user.email,
      createdAt: FieldValue.serverTimestamp(),
      deletedAt: null,
      dailyCostCapUsd: null,
    });
  } else {
    // Keep email fresh if the user changed it on the auth provider side,
    // but never clobber locally-set fields (set merge respects them).
    await userRef.set({ email: user.email }, { merge: true });
  }
  await seedBebopCampaign(user.id);
}
