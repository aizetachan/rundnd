import { getCurrentUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { ensureSessionZeroCampaign } from "@/lib/session-zero/ensure-campaign";
import { loadSessionZero } from "@/lib/session-zero/state";
import { redirect } from "next/navigation";
import SzUI from "./sz-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Session Zero entry point. Find-or-create the user's active SZ
 * campaign, then render the conductor chat. Sub 5 will move this to
 * `/sz/[campaignId]/page.tsx` once resume controls are surfaced from
 * the campaigns list — for now there's at most one active SZ per user
 * at a time and `/sz` always picks it up.
 *
 * The find-or-create is server-side so a player who closes the tab
 * mid-conversation can return to `/sz` and continue. The conductor's
 * own state lives in the SZ doc (conversation_history etc.); this
 * page just loads it and hands it to the client UI.
 */
export default async function SessionZeroPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const firestore = getFirebaseFirestore();
  const { campaignId } = await ensureSessionZeroCampaign(firestore, user.id);
  const sz = await loadSessionZero(firestore, campaignId);

  // If the SZ has already finalized (sub 4 lands), the player belongs
  // on /play. Defensive — sub 4 will redirect from finalize itself,
  // but a manual hit of /sz on a completed campaign should still DTRT.
  if (sz.phase === "complete") {
    redirect(`/campaigns/${campaignId}/play`);
  }

  return (
    <SzUI
      campaignId={campaignId}
      priorHistory={sz.conversationHistory.map((m) => ({
        role: m.role,
        text: m.text,
        // Surface a flat tool-call summary the UI can render as a
        // sidecar without re-shaping. Conductor-side and player-side
        // entries both pass through unchanged.
        tool_calls: m.tool_calls.map((c) => ({ name: c.name })),
      }))}
      hardRequirementsMet={sz.hardRequirementsMet}
    />
  );
}
