import { getFirebaseAuth, getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { cookies } from "next/headers";

/**
 * Shape every caller sees. Same contract as before so call sites don't
 * change when migrating Clerk → Firebase Auth. Extra Firebase fields
 * (provider data, photoURL, etc.) should flow through this helper rather
 * than leak across the codebase.
 */
export type AppUser = {
  id: string;
  email: string | null;
};

/**
 * Reads the `__session` cookie set by POST /api/auth/session and
 * verifies it against Firebase Admin. Returns null when the cookie is
 * missing, invalid, or when the user is soft-deleted.
 *
 * `checkRevoked = true` on verifySessionCookie makes the verification
 * round-trip to Firebase Auth to confirm the session hasn't been
 * revoked (e.g. user signed out elsewhere, password reset).
 *
 * `deletedAt` check (M3 sub 2): a soft-deleted user has a valid
 * session cookie (14-day TTL) until it expires, but the runtime
 * gate here ensures they can't keep acting on the app once delete
 * happened. Cookies could be revoked instead, but Firebase Auth
 * doesn't expose a clean per-user revocation outside admin-side
 * password resets — the Firestore check is the cheap reliable seam.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
  const cookieStore = await cookies();
  const session = cookieStore.get("__session")?.value;
  if (!session) return null;

  let decoded: { uid: string; email?: string };
  try {
    decoded = await getFirebaseAuth().verifySessionCookie(session, true);
  } catch {
    return null;
  }

  // Deleted-user runtime gate. Skipped on first-sign-in (the lazy upsert
  // in /api/auth/session creates the user doc; if it hasn't run yet
  // there's no doc to check, and we let the request proceed — the
  // upsert path is the one that calls verify + delete in sequence, so
  // a missing doc here means it's a genuine first visit).
  try {
    const userSnap = await getFirebaseFirestore()
      .collection(COL.users)
      .doc(decoded.uid)
      .get();
    if (userSnap.exists && userSnap.data()?.deletedAt != null) {
      return null;
    }
  } catch {
    // Firestore unavailable — fail open rather than block sign-in. The
    // user can use the app; if they happened to be soft-deleted the
    // queries downstream still filter by deletedAt==null and return
    // empty, so the worst case is "looks empty" not "data leak".
  }

  return {
    id: decoded.uid,
    email: decoded.email ?? null,
  };
}
