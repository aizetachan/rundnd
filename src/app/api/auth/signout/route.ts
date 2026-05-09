import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/signout — clear the session cookie.
 *
 * The client should also call signOut() on the Firebase client SDK to
 * tear down its local state; this endpoint only handles the server-side
 * cookie. Calling them in either order is fine — both must happen for a
 * clean sign-out.
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("__session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return res;
}
