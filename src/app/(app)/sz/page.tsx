import { getCurrentUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { ensureSessionZeroCampaign } from "@/lib/session-zero/ensure-campaign";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bare `/sz` is now a bootstrap that find-or-creates the user's
 * active SZ and redirects to `/sz/{campaignId}`. The actual chat UI
 * lives at `/sz/[campaignId]/page.tsx` so a player resuming from the
 * campaigns list lands on a stable URL they can bookmark or refresh.
 *
 * Why redirect instead of rendering inline: the `/sz/[campaignId]`
 * route is the single source of truth for "render an SZ chat." The
 * bare route's only job is choosing WHICH campaign — once chosen, it
 * hands off so refresh + back-button + share-link all work with the
 * concrete id.
 */
export default async function SessionZeroBootstrapPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const firestore = getFirebaseFirestore();
  const { campaignId } = await ensureSessionZeroCampaign(firestore, user.id);
  redirect(`/sz/${campaignId}`);
}
