import { getCurrentUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { ensureUserSeeded } from "@/lib/seed/ensure-seeded";
import Link from "next/link";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  // Backfill users-row + Bebop campaign for accounts that slipped past
  // the auth-side seed. Idempotent — fresh sign-in seeded users no-op
  // through here. See src/lib/seed/ensure-seeded.ts for rationale.
  try {
    await ensureUserSeeded(user);
  } catch (err) {
    console.error("ensureUserSeeded failed on /campaigns load", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Firestore can't combine `==` and `is null` filters cleanly without an
  // index that explicitly stores the null. The `deletedAt == null`
  // ordering is required by ensureUserSeeded which writes the field
  // explicitly. Composite index needs (ownerUid asc, deletedAt asc,
  // createdAt desc) for this query — declared in firestore.indexes.json
  // (or auto-suggested by the console on first run).
  const snap = await getFirebaseFirestore()
    .collection(COL.campaigns)
    .where("ownerUid", "==", user.id)
    .where("deletedAt", "==", null)
    .orderBy("createdAt", "desc")
    .get();
  const rows = snap.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id,
      name: typeof r.name === "string" ? r.name : "",
      phase: typeof r.phase === "string" ? r.phase : "sz",
    };
  });

  const greeting = user.email ?? user.id;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">hello, {greeting}</h1>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          Your campaign is still being seeded. Refresh in a moment — the Bebop demo campaign should
          appear shortly after your first sign-in.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((c) => (
            <li
              key={c.id}
              className="flex items-stretch gap-2 rounded-lg border hover:border-foreground/20"
            >
              <Link
                href={`/campaigns/${c.id}/play`}
                className="flex flex-1 items-center justify-between p-4 hover:bg-muted/40"
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground text-xs uppercase tracking-wider">
                  {c.phase}
                </span>
              </Link>
              <Link
                href={`/campaigns/${c.id}/settings`}
                className="flex items-center border-l px-4 text-muted-foreground text-xs hover:bg-muted/40 hover:text-foreground"
                aria-label={`Settings for ${c.name}`}
              >
                settings
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
