import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL, SESSION_ZERO_DOC_ID } from "@/lib/firestore";
import type { Firestore, Timestamp } from "firebase-admin/firestore";

/**
 * User-facing JSON export — bundles the user's full state into a
 * single downloadable artifact. Used by POST /api/users/export and
 * also callable from the CLI / debug scripts.
 *
 * Scope (per docs/plans/M3-persistent-campaigns.md §sub 1):
 *   - User row (id, email)
 *   - All campaigns the user owns (deletedAt == null)
 *   - Per campaign: settings, turns, characters, context_blocks,
 *     semantic_memories, session_zero state (when present).
 *
 * Excluded:
 *   - Provisional memory writes (M3+; the writer lands at M3+).
 *   - OpeningStatePackage versioned artifacts (verbose; recoverable
 *     from session_zero + the latest turn).
 *   - Other users' data (auth check is the caller's responsibility).
 *   - Algolia index records (recoverable from the Firestore source).
 *
 * Output is a JSON-serializable object, NOT a string — the route
 * handler streams it via NextResponse.json. The
 * `coerceTimestamp` helper turns Firestore Timestamps into ISO
 * strings so JSON.stringify produces sensible output.
 */

export const EXPORT_SCHEMA_VERSION = "v1";

export interface ExportBundle {
  schema_version: string;
  exported_at: string;
  user: { id: string; email: string | null };
  campaigns: ExportCampaign[];
}

export interface ExportCampaign {
  id: string;
  name: string;
  phase: string;
  profile_refs: string[];
  settings: unknown;
  created_at: string | null;
  turns: ExportTurn[];
  characters: ExportCharacter[];
  context_blocks: ExportContextBlock[];
  semantic_memories: ExportSemanticMemory[];
  session_zero: ExportSessionZero | null;
}

export interface ExportTurn {
  turn_number: number;
  player_message: string;
  narrative_text: string;
  summary: string | null;
  intent: unknown;
  outcome: unknown;
  verdict_kind: string;
  cost_usd: number | null;
  created_at: string | null;
}

export interface ExportCharacter {
  name: string;
  concept: string;
  power_tier: string | null;
  sheet: unknown;
  created_at: string | null;
}

export interface ExportContextBlock {
  block_type: string;
  entity_name: string;
  status: string;
  version: number;
  content: string;
  continuity_checklist: unknown;
  last_updated_turn: number;
}

export interface ExportSemanticMemory {
  category: string;
  content: string;
  heat: number;
  flags: unknown;
  turn_number: number;
}

export interface ExportSessionZero {
  phase: string;
  profile_refs: string[];
  canonicality_mode: string | null;
  character_draft: unknown;
  starting_location: string | null;
  starting_situation: string | null;
  conversation_history: unknown[];
}

function coerceTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "object" && value !== null && "toDate" in value) {
    try {
      return (value as Timestamp).toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

/**
 * Build the full bundle for the given user. Loads everything in
 * parallel-where-safe, sequentially-where-needed (per-campaign loops).
 * Caller handles auth + serialization.
 */
export async function buildExportBundle(
  userId: string,
  email: string | null,
  firestore: Firestore = getFirebaseFirestore(),
): Promise<ExportBundle> {
  const campaignsSnap = await firestore
    .collection(COL.campaigns)
    .where("ownerUid", "==", userId)
    .where("deletedAt", "==", null)
    .orderBy("createdAt", "asc")
    .get();

  const campaigns: ExportCampaign[] = [];
  for (const campDoc of campaignsSnap.docs) {
    const cd = campDoc.data();
    const campaignId = campDoc.id;

    // Load every subcollection for this campaign in parallel — they're
    // independent, the size is bounded per-campaign.
    const [turnsSnap, charsSnap, blocksSnap, semanticSnap, szSnap] = await Promise.all([
      campDoc.ref.collection(CAMPAIGN_SUB.turns).orderBy("turnNumber", "asc").get(),
      campDoc.ref.collection(CAMPAIGN_SUB.characters).get(),
      campDoc.ref.collection(CAMPAIGN_SUB.contextBlocks).get(),
      campDoc.ref.collection(CAMPAIGN_SUB.semanticMemories).orderBy("turnNumber", "asc").get(),
      campDoc.ref.collection(CAMPAIGN_SUB.sessionZero).doc(SESSION_ZERO_DOC_ID).get(),
    ]);

    const turns: ExportTurn[] = turnsSnap.docs.map((d) => {
      const r = d.data();
      return {
        turn_number: typeof r.turnNumber === "number" ? r.turnNumber : 0,
        player_message: typeof r.playerMessage === "string" ? r.playerMessage : "",
        narrative_text: typeof r.narrativeText === "string" ? r.narrativeText : "",
        summary: typeof r.summary === "string" ? r.summary : null,
        intent: r.intent ?? null,
        outcome: r.outcome ?? null,
        verdict_kind: typeof r.verdictKind === "string" ? r.verdictKind : "continue",
        cost_usd: typeof r.costUsd === "number" ? r.costUsd : null,
        created_at: coerceTimestamp(r.createdAt),
      };
    });

    const characters: ExportCharacter[] = charsSnap.docs.map((d) => {
      const r = d.data();
      return {
        name: typeof r.name === "string" ? r.name : "",
        concept: typeof r.concept === "string" ? r.concept : "",
        power_tier: typeof r.powerTier === "string" ? r.powerTier : null,
        sheet: r.sheet ?? null,
        created_at: coerceTimestamp(r.createdAt),
      };
    });

    const contextBlocks: ExportContextBlock[] = blocksSnap.docs.map((d) => {
      const r = d.data();
      return {
        block_type: typeof r.blockType === "string" ? r.blockType : "",
        entity_name: typeof r.entityName === "string" ? r.entityName : "",
        status: typeof r.status === "string" ? r.status : "active",
        version: typeof r.version === "number" ? r.version : 1,
        content: typeof r.content === "string" ? r.content : "",
        continuity_checklist: r.continuityChecklist ?? {},
        last_updated_turn: typeof r.lastUpdatedTurn === "number" ? r.lastUpdatedTurn : 0,
      };
    });

    const semanticMemories: ExportSemanticMemory[] = semanticSnap.docs.map((d) => {
      const r = d.data();
      return {
        category: typeof r.category === "string" ? r.category : "",
        content: typeof r.content === "string" ? r.content : "",
        heat: typeof r.heat === "number" ? r.heat : 0,
        flags: r.flags ?? {},
        turn_number: typeof r.turnNumber === "number" ? r.turnNumber : 0,
      };
    });

    let sessionZero: ExportSessionZero | null = null;
    if (szSnap.exists) {
      const r = szSnap.data() ?? {};
      sessionZero = {
        phase: typeof r.phase === "string" ? r.phase : "not_started",
        profile_refs: Array.isArray(r.profile_refs) ? (r.profile_refs as string[]) : [],
        canonicality_mode: typeof r.canonicality_mode === "string" ? r.canonicality_mode : null,
        character_draft: r.character_draft ?? null,
        starting_location: typeof r.starting_location === "string" ? r.starting_location : null,
        starting_situation: typeof r.starting_situation === "string" ? r.starting_situation : null,
        conversation_history: Array.isArray(r.conversation_history)
          ? (r.conversation_history as unknown[])
          : [],
      };
    }

    campaigns.push({
      id: campaignId,
      name: typeof cd.name === "string" ? cd.name : "",
      phase: typeof cd.phase === "string" ? cd.phase : "sz",
      profile_refs: Array.isArray(cd.profileRefs) ? (cd.profileRefs as string[]) : [],
      settings: cd.settings ?? {},
      created_at: coerceTimestamp(cd.createdAt),
      turns,
      characters,
      context_blocks: contextBlocks,
      semantic_memories: semanticMemories,
      session_zero: sessionZero,
    });
  }

  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    user: { id: userId, email },
    campaigns,
  };
}
