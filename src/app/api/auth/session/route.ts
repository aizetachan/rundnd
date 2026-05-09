import { getFirebaseAuth } from "@/lib/firebase/admin";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/session — exchange a Firebase ID token for a long-lived
 * session cookie.
 *
 * Flow:
 *   client signs in (signInWithPopup / signInWithEmailAndPassword)
 *     → calls user.getIdToken()
 *     → POSTs the token here
 *     → we verify with Admin SDK, then mint a session cookie via
 *       createSessionCookie() and set it as httpOnly so it cannot be
 *       read by JS.
 *
 * Server-side reads (middleware, getCurrentUser) verify this cookie with
 * verifySessionCookie() — they never see the raw ID token. This keeps
 * server auth durable across tab close while the client-side ID token
 * (1h TTL) refreshes itself transparently.
 *
 * Cookie name `__session` — Firebase Hosting strips most cookies before
 * forwarding to Cloud Run for caching reasons; `__session` is the only
 * cookie name that passes through. Future-proofs against any Firebase
 * Hosting layer in front of App Hosting.
 */

const Body = z.object({
  idToken: z.string().min(1),
});

const SESSION_DURATION_MS = 60 * 60 * 24 * 14 * 1000; // 14 days — Firebase max for session cookies

// Detail strings from Firebase Admin (e.g. "ID token has expired" vs
// "ID token has invalid signature") are useful in dev but act as a
// validity oracle in prod. Gate the `detail` field accordingly — the
// client only consumes `body.error` anyway.
const isDev = process.env.NODE_ENV !== "production";

export async function POST(req: NextRequest) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      isDev
        ? { error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }
        : { error: "invalid_body" },
      { status: 400 },
    );
  }

  const auth = getFirebaseAuth();
  let cookie: string;
  try {
    // verifyIdToken first — createSessionCookie will also reject invalid
    // tokens, but verifying explicitly gives a cleaner error path and
    // lets us check `auth_time` (must be < 5 min for session cookie
    // creation, per Firebase recommendation against token replay).
    const decoded = await auth.verifyIdToken(body.idToken);
    const ageSec = Math.floor(Date.now() / 1000) - decoded.auth_time;
    if (ageSec > 5 * 60) {
      return NextResponse.json({ error: "stale_token" }, { status: 401 });
    }
    cookie = await auth.createSessionCookie(body.idToken, {
      expiresIn: SESSION_DURATION_MS,
    });
  } catch (err) {
    return NextResponse.json(
      isDev
        ? { error: "invalid_token", detail: err instanceof Error ? err.message : String(err) }
        : { error: "invalid_token" },
      { status: 401 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("__session", cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
    path: "/",
  });
  return res;
}
