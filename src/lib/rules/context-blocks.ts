import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Read-path helper for context_blocks (Phase 3C of v3-audit closure).
 *
 * assembleSessionContextBlocks pulls all `active` blocks for a campaign
 * and renders them as a Markdown bundle for Block 2 of KA's systemPrompt.
 * Block 2 is semi-static (invalidates on any block update); the bundle
 * is the "session-start briefing" KA reads before scene one.
 *
 * Ordering:
 *   arc → thread → quest → faction → location → npc
 * so the broad-stroke narrative context comes first and character-level
 * detail follows. Stable across turns within a session.
 *
 * Budget: target <3000 tokens total per plan §3 Phase audit focus. Each
 * block averages ~400 tokens; per-type cap ensures no single category
 * (especially NPCs, which scale fastest) starves the others as the
 * campaign grows.
 */

const BLOCK_TYPE_ORDER = ["arc", "thread", "quest", "faction", "location", "npc"] as const;
/** Max blocks per category. Keeps the briefing balanced as the campaign
 * accumulates — 3 NPCs × 6 categories ≈ 18 blocks worst case, bounded by
 * MAX_TOTAL. Oldest-updated blocks within each category drop first. */
const PER_TYPE_CAP = 3;
/** Hard cap across all categories. ~10 × 400 tokens ≈ 4k, a ~30% overshoot
 * of the <3000 target that's acceptable given Block 2 is cache-eligible
 * and amortizes across turns within a session. */
const MAX_TOTAL = 10;

interface ContextBlockRow {
  blockType: string;
  entityName: string;
  content: string;
  continuityChecklist: Record<string, unknown>;
  lastUpdatedTurn: number;
}

export async function assembleSessionContextBlocks(
  firestore: Firestore,
  campaignId: string,
): Promise<string> {
  // Pull ALL active blocks — no DB-level alphabetical order (alphabetical
  // != canonical) and no early limit (it would starve NPCs). In-memory
  // sort + per-type cap is the only way to preserve canonical briefing
  // order + prevent one category from eating the budget.
  const snap = await firestore
    .collection(COL.campaigns)
    .doc(campaignId)
    .collection(CAMPAIGN_SUB.contextBlocks)
    .where("status", "==", "active")
    .orderBy("lastUpdatedTurn", "desc")
    .limit(500)
    .get();

  if (snap.empty) return "";

  const rows: ContextBlockRow[] = snap.docs.map((d) => {
    const r = d.data();
    return {
      blockType: typeof r.blockType === "string" ? r.blockType : "",
      entityName: typeof r.entityName === "string" ? r.entityName : "",
      content: typeof r.content === "string" ? r.content : "",
      continuityChecklist:
        typeof r.continuityChecklist === "object" && r.continuityChecklist !== null
          ? (r.continuityChecklist as Record<string, unknown>)
          : {},
      lastUpdatedTurn: typeof r.lastUpdatedTurn === "number" ? r.lastUpdatedTurn : 0,
    };
  });

  // Bucket by block_type and keep the PER_TYPE_CAP most-recently-updated
  // within each bucket (rows are already last-updated-desc from the
  // query).
  const byType = new Map<string, ContextBlockRow[]>();
  for (const row of rows) {
    const list = byType.get(row.blockType) ?? [];
    if (list.length < PER_TYPE_CAP) list.push(row);
    byType.set(row.blockType, list);
  }

  // Materialize in canonical order up to MAX_TOTAL.
  const capped: ContextBlockRow[] = [];
  for (const blockType of BLOCK_TYPE_ORDER) {
    const list = byType.get(blockType);
    if (!list) continue;
    for (const row of list) {
      if (capped.length >= MAX_TOTAL) break;
      capped.push(row);
    }
    if (capped.length >= MAX_TOTAL) break;
  }

  // Group for rendering (preserves canonical order because we iterated
  // over BLOCK_TYPE_ORDER above).
  const grouped = new Map<string, ContextBlockRow[]>();
  for (const row of capped) {
    const list = grouped.get(row.blockType) ?? [];
    list.push(row);
    grouped.set(row.blockType, list);
  }

  const sections: string[] = [];
  for (const blockType of BLOCK_TYPE_ORDER) {
    const list = grouped.get(blockType);
    if (!list || list.length === 0) continue;
    const heading = sectionHeading(blockType);
    const body = list
      .map((b) => {
        const checklist = formatChecklist(b.continuityChecklist);
        return `#### ${b.entityName}\n\n${b.content.trim()}${checklist ? `\n\n${checklist}` : ""}`;
      })
      .join("\n\n");
    sections.push(`### ${heading}\n\n${body}`);
  }

  return sections.join("\n\n---\n\n");
}

function sectionHeading(blockType: string): string {
  switch (blockType) {
    case "arc":
      return "Current arc";
    case "thread":
      return "Active threads";
    case "quest":
      return "Active quests";
    case "npc":
      return "NPCs in play";
    case "faction":
      return "Factions in play";
    case "location":
      return "Active locations";
    default:
      return blockType;
  }
}

function formatChecklist(checklist: Record<string, unknown>): string {
  const keys = Object.keys(checklist);
  if (keys.length === 0) return "";
  const lines = keys.map((k) => `  - ${k}: ${JSON.stringify(checklist[k])}`);
  return `**Continuity**\n${lines.join("\n")}`;
}
