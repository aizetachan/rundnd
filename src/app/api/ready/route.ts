import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { pingAnthropic } from "@/lib/llm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe — issues a tiny Firestore read against an internal
 * `__health` doc that doesn't need to exist. The Admin SDK still
 * round-trips through GCP, which is enough to confirm credentials,
 * network, and the Firestore back-end. Fast (low-tens-of-ms) and
 * doesn't write anything.
 */
async function checkFirestore(): Promise<"ok" | "fail"> {
  try {
    await getFirebaseFirestore().collection("__health").doc("__ping").get();
    return "ok";
  } catch (err) {
    console.error("[ready] firestore check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "fail";
  }
}

export async function GET() {
  // Parallel checks; each has its own timeout. Slowest bounded at ~3s so
  // upstream healthchecks (Railway / App Hosting / etc.) stay well within
  // limits.
  const [firestore, anthropic] = await Promise.all([
    checkFirestore(),
    pingAnthropic(3000).then((ok) => (ok ? ("ok" as const) : ("fail" as const))),
  ]);
  const checks = { firestore, anthropic };
  const ok = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json({ status: ok ? "ok" : "degraded", checks }, { status: ok ? 200 : 503 });
}
