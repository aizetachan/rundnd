import { softDeleteUser } from "@/lib/account/soft-delete";
import { getCurrentUser } from "@/lib/auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/users/delete — soft-delete the authenticated user.
 *
 * Two-step UX confirm lives on the client (mirrors the abandon-
 * campaign pattern). This endpoint is the second step: it just
 * runs the soft delete. The client clears the session cookie
 * via /api/auth/signout after this returns ok.
 *
 * Hard delete runs ~24h later via scripts/users-hard-delete.ts
 * (manual cron at M3 first ship; Cloud Scheduler at M9 or admin
 * surface, whichever lands first).
 */
export async function POST(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const result = await softDeleteUser(user.id);
  return NextResponse.json({ ok: true, ...result });
}
