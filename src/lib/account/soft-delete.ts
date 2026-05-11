import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Soft-delete a user and every campaign they own. Sets `deletedAt` to
 * the current server timestamp on both the user doc and each
 * campaigns/{id} doc owned by the user, inside a single transaction
 * so callers see a consistent state.
 *
 * Hard-delete (purging subcollections + the docs themselves) runs ~24h
 * later via `scripts/users-hard-delete.ts`. The 24h window gives the
 * player a path to "I changed my mind" — if they sign in within the
 * window, the auth flow could in theory restore the row (M3+ feature;
 * not implemented today). After 24h the data is gone for good.
 *
 * Side effects callers depend on:
 *   - getCurrentUser() reads users/{uid}.deletedAt; non-null returns
 *     null from getCurrentUser so middleware bounces to /sign-in.
 *   - The campaigns list query filters where deletedAt==null, so the
 *     deleted-state user couldn't see their own campaigns even if
 *     auth somehow let them through.
 *
 * Returns the number of campaigns marked. 0 is a valid result (user
 * with no campaigns).
 */
export async function softDeleteUser(
  userId: string,
  firestore: Firestore = getFirebaseFirestore(),
): Promise<{ deletedCampaigns: number }> {
  const userRef = firestore.collection(COL.users).doc(userId);
  // Find all the campaigns up front (outside the transaction) so the
  // transaction's read set stays small. The race window — a new
  // campaign created between this read and the transaction commit —
  // would survive soft-delete; the hard-delete cron would mop it up
  // when it scans `where(deletedAt < ...)` for the user.
  const ownedSnap = await firestore
    .collection(COL.campaigns)
    .where("ownerUid", "==", userId)
    .where("deletedAt", "==", null)
    .get();

  await firestore.runTransaction(async (tx) => {
    tx.set(userRef, { deletedAt: FieldValue.serverTimestamp() }, { merge: true });
    for (const campDoc of ownedSnap.docs) {
      tx.set(campDoc.ref, { deletedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
  });

  return { deletedCampaigns: ownedSnap.size };
}
