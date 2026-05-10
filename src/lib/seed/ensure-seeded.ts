import type { AppUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Lazy upsert of the `users/{uid}` doc on sign-in. Invoked from
 * POST /api/auth/session right after the ID token verifies, so the
 * cost ledger + daily-cap reads have a row to land on the first
 * time the player hits the budget gate.
 *
 * Bebop auto-seed (M2 Wave A sub 6 cutover): this used to call
 * `seedBebopCampaign` so a fresh sign-in landed on a playable
 * campaign immediately. Now new users land on `/campaigns` empty
 * and walk through Session Zero via the "+ Start a new campaign"
 * CTA. `seedBebopCampaign` itself stays in the codebase as a
 * dev-debug entry point invocable through `pnpm seed:campaign`.
 *
 * Idempotent: a transactional read-then-set on `users/{uid}` so
 * concurrent first-time POSTs converge without clobbering an already-
 * set `dailyCostCapUsd` (Firestore merge writes nulls verbatim
 * rather than skipping them).
 */
export async function ensureUserSeeded(user: AppUser): Promise<void> {
  if (!user.email) return;
  const db = getFirebaseFirestore();
  const userRef = db.collection(COL.users).doc(user.id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) {
      tx.set(userRef, {
        id: user.id,
        email: user.email,
        createdAt: FieldValue.serverTimestamp(),
        deletedAt: null,
        dailyCostCapUsd: null,
      });
    } else {
      tx.set(userRef, { email: user.email }, { merge: true });
    }
  });
}
