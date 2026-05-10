import { getCurrentUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { loadSessionZero } from "@/lib/session-zero/state";
import { notFound, redirect } from "next/navigation";
import SzUI from "../sz-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ campaignId: string }>;
}

/**
 * Session Zero resume route. Loads a specific campaign's SZ state and
 * renders the conductor chat for it. Distinct from `/sz` (the bare
 * route) which finds-or-creates the user's active SZ — this route
 * lets the player jump directly into a known campaign id from the
 * campaigns list's "Continue Session Zero" affordance.
 *
 * Authz: 404 if the campaign doesn't exist, isn't owned by the
 * caller, or is soft-deleted. The phase guard pushes finalized
 * campaigns to /play (same defense as /sz).
 */
export default async function ResumeSessionZeroPage({ params }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { campaignId } = await params;
  const firestore = getFirebaseFirestore();

  const campaignSnap = await firestore.collection(COL.campaigns).doc(campaignId).get();
  if (!campaignSnap.exists) notFound();
  const cd = campaignSnap.data();
  if (!cd || cd.ownerUid !== user.id || cd.deletedAt !== null) notFound();
  if (cd.phase !== "session_zero" && cd.phase !== "sz") {
    redirect(`/campaigns/${campaignId}/play`);
  }

  const sz = await loadSessionZero(firestore, campaignId);
  if (sz.phase === "complete") {
    redirect(`/campaigns/${campaignId}/play`);
  }

  return (
    <SzUI
      campaignId={campaignId}
      priorHistory={sz.conversationHistory.map((m) => ({
        role: m.role,
        text: m.text,
        tool_calls: m.tool_calls.map((c) => ({ name: c.name })),
      }))}
      hardRequirementsMet={sz.hardRequirementsMet}
    />
  );
}
