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

interface CharacterCard {
  name: string;
  concept: string;
  power_tier: string | null;
  abilities: Array<{ name: string; description: string; limitations?: string | null }>;
  hp: number | null;
  status_effects: string[];
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

  // Load turns + character in parallel — both feed the UI on initial render.
  const [turnsSnap, charsSnap] = await Promise.all([
    firestore
      .collection(COL.campaigns)
      .doc(id)
      .collection(CAMPAIGN_SUB.turns)
      .orderBy("turnNumber", "asc")
      .get(),
    firestore.collection(COL.campaigns).doc(id).collection(CAMPAIGN_SUB.characters).limit(1).get(),
  ]);

  const priorTurns = turnsSnap.docs.map((d) => {
    const r = d.data();
    return {
      turn_number: typeof r.turnNumber === "number" ? r.turnNumber : 0,
      player_message: typeof r.playerMessage === "string" ? r.playerMessage : "",
      narrative_text: typeof r.narrativeText === "string" ? r.narrativeText : "",
    };
  });

  // Project the character row into a compact sidebar card. Read-only at
  // M2.5; in-fiction edits route through WorldBuilder per ROADMAP §10.8.
  let character: CharacterCard | null = null;
  const charDoc = charsSnap.docs[0];
  if (charDoc) {
    const c = charDoc.data();
    const sheet = (c.sheet ?? {}) as {
      power_tier?: string;
      abilities?: Array<{ name: string; description: string; limitations?: string | null }>;
      current_state?: { hp?: number | null; status_effects?: string[] };
    };
    character = {
      name: typeof c.name === "string" ? c.name : "",
      concept: typeof c.concept === "string" ? c.concept : "",
      power_tier: sheet.power_tier ?? (typeof c.powerTier === "string" ? c.powerTier : null),
      abilities: Array.isArray(sheet.abilities) ? sheet.abilities : [],
      hp: sheet.current_state?.hp ?? null,
      status_effects: sheet.current_state?.status_effects ?? [],
    };
  }

  return (
    <PlayUI
      campaignId={campaignSnap.id}
      campaignName={typeof cd.name === "string" ? cd.name : ""}
      priorTurns={priorTurns}
      character={character}
    />
  );
}
