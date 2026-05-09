import { getCurrentUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { notFound, redirect } from "next/navigation";
import PlayUI from "./play-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PlayPage({ params }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const firestore = getFirebaseFirestore();

  const campaignSnap = await firestore.collection(COL.campaigns).doc(id).get();
  if (!campaignSnap.exists) notFound();
  const cd = campaignSnap.data();
  if (!cd || cd.ownerUid !== user.id || cd.deletedAt !== null) notFound();

  const turnsSnap = await firestore
    .collection(COL.campaigns)
    .doc(id)
    .collection(CAMPAIGN_SUB.turns)
    .orderBy("turnNumber", "asc")
    .get();
  const priorTurns = turnsSnap.docs.map((d) => {
    const r = d.data();
    return {
      turn_number: typeof r.turnNumber === "number" ? r.turnNumber : 0,
      player_message: typeof r.playerMessage === "string" ? r.playerMessage : "",
      narrative_text: typeof r.narrativeText === "string" ? r.narrativeText : "",
    };
  });

  return (
    <PlayUI
      campaignId={campaignSnap.id}
      campaignName={typeof cd.name === "string" ? cd.name : ""}
      priorTurns={priorTurns}
    />
  );
}
