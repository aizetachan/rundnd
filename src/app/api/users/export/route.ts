import { buildExportBundle } from "@/lib/account/export";
import { getCurrentUser } from "@/lib/auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/users/export — JSON bundle of the user's full state.
 *
 * Auth: session cookie. Only the authenticated user gets their own
 * data — there's no admin override and no userId query param.
 *
 * Response shape: ExportBundle (src/lib/account/export.ts). Content
 * disposition is attachment so the browser downloads rather than
 * renders it inline.
 *
 * Per ROADMAP §15 + M3 plan sub 1.
 */
export async function POST(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const bundle = await buildExportBundle(user.id, user.email);
  const filename = `aidm-export-${user.id}-${Date.now()}.json`;
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
