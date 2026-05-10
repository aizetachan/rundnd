import { getCurrentUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import MemoryUI from "./memory-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

interface EpisodicEntry {
  turn_number: number;
  player_message: string;
  summary: string | null;
  narrative_excerpt: string;
  created_at: string | null;
}

interface SemanticEntry {
  id: string;
  category: string;
  content: string;
  heat: number;
  flags: Record<string, unknown>;
  turn_number: number;
}

interface ContextBlockEntry {
  id: string;
  block_type: string;
  entity_name: string;
  status: string;
  version: number;
  last_updated_turn: number;
  content: string;
}

export default async function MemoryPage({ params }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const firestore = getFirebaseFirestore();

  // Auth check — same shape as /play. Only the campaign owner can read.
  const campaignSnap = await firestore.collection(COL.campaigns).doc(id).get();
  if (!campaignSnap.exists) notFound();
  const cd = campaignSnap.data();
  if (!cd || cd.ownerUid !== user.id || cd.deletedAt !== null) notFound();
  const campaignName = typeof cd.name === "string" ? cd.name : "";

  // Load all three layers in parallel. Caps applied per layer:
  //   - turns: last 30 (episodic memory is recency-biased anyway)
  //   - semantic: top 50 by heat (high-signal first; tail isn't useful for inspection)
  //   - context blocks: all (these are aggregate per-entity docs, small in count)
  const [turnsSnap, semanticSnap, blocksSnap] = await Promise.all([
    firestore
      .collection(COL.campaigns)
      .doc(id)
      .collection(CAMPAIGN_SUB.turns)
      .orderBy("turnNumber", "desc")
      .limit(30)
      .get(),
    firestore
      .collection(COL.campaigns)
      .doc(id)
      .collection(CAMPAIGN_SUB.semanticMemories)
      .orderBy("heat", "desc")
      .limit(50)
      .get(),
    firestore
      .collection(COL.campaigns)
      .doc(id)
      .collection(CAMPAIGN_SUB.contextBlocks)
      .orderBy("lastUpdatedTurn", "desc")
      .get(),
  ]);

  const episodic: EpisodicEntry[] = turnsSnap.docs.map((d) => {
    const r = d.data();
    const narrative = typeof r.narrativeText === "string" ? r.narrativeText : "";
    const created = r.createdAt;
    let createdAtIso: string | null = null;
    if (created && typeof created === "object" && "toDate" in created) {
      createdAtIso = (created as { toDate: () => Date }).toDate().toISOString();
    }
    return {
      turn_number: typeof r.turnNumber === "number" ? r.turnNumber : 0,
      player_message: typeof r.playerMessage === "string" ? r.playerMessage : "",
      summary: typeof r.summary === "string" ? r.summary : null,
      // Excerpt — first 280 chars of narrative for the inspection table.
      narrative_excerpt: narrative.length > 280 ? `${narrative.slice(0, 280)}…` : narrative,
      created_at: createdAtIso,
    };
  });

  const semantic: SemanticEntry[] = semanticSnap.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id,
      category: typeof r.category === "string" ? r.category : "",
      content: typeof r.content === "string" ? r.content : "",
      heat: typeof r.heat === "number" ? r.heat : 0,
      flags: (r.flags ?? {}) as Record<string, unknown>,
      turn_number: typeof r.turnNumber === "number" ? r.turnNumber : 0,
    };
  });

  const contextBlocks: ContextBlockEntry[] = blocksSnap.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id,
      block_type: typeof r.blockType === "string" ? r.blockType : "",
      entity_name: typeof r.entityName === "string" ? r.entityName : "",
      status: typeof r.status === "string" ? r.status : "active",
      version: typeof r.version === "number" ? r.version : 1,
      last_updated_turn: typeof r.lastUpdatedTurn === "number" ? r.lastUpdatedTurn : 0,
      content: typeof r.content === "string" ? r.content : "",
    };
  });

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <Link
            href={`/campaigns/${id}/play`}
            className="text-muted-foreground text-sm hover:text-foreground"
          >
            ← back to play
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {campaignName}
            <span className="ml-3 font-normal text-muted-foreground text-base">memory</span>
          </h1>
        </div>
        <div className="text-right text-muted-foreground text-xs">
          <div>{episodic.length} recent turns · {semantic.length} memories · {contextBlocks.length} blocks</div>
          <div className="mt-0.5 italic">read-only view</div>
        </div>
      </header>

      <MemoryUI episodic={episodic} semantic={semantic} contextBlocks={contextBlocks} />
    </div>
  );
}
