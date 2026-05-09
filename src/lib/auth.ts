import { getFirebaseAuth } from "@/lib/firebase/admin";
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
 * missing or invalid — never throws on auth-state checks (the original
 * Clerk helper also returned null silently). Throws only on Admin SDK
 * misconfiguration, which surfaces as a 500 elsewhere.
 *
 * `checkRevoked = true` makes the verification round-trip to Firebase
 * to confirm the session hasn't been revoked (e.g. user signed out
 * elsewhere, password reset). Adds latency on every request; the trade
 * is correctness over speed for now. M0.5 retro will revisit if hot
 * paths need to relax this.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
  const cookieStore = await cookies();
  const session = cookieStore.get("__session")?.value;
  if (!session) return null;

  try {
    const decoded = await getFirebaseAuth().verifySessionCookie(session, true);
    return {
      id: decoded.uid,
      email: decoded.email ?? null,
    };
  } catch {
    return null;
  }
}
