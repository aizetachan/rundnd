import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import type { Composition } from "@/lib/types/composition";
import type { DNAScales } from "@/lib/types/dna";
import type { Profile } from "@/lib/types/profile";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Rule library getters — deterministic lookups keyed on (category, axis,
 * value_key). The content lives in `ruleLibraryChunks` (populated by
 * `pnpm rules:index` from `rule_library/**\/*.yaml`).
 *
 * At session start, `assembleSessionRuleLibraryGuidance` pulls the
 * campaign-relevant subset (24 DNA + 13 composition + character tier +
 * in-play archetypes) and concatenates a prose bundle KA reads in
 * Block 1 under "Rule-library guidance for this session". Block 1 is
 * cached across the session, so the bundle is computed once per turn
 * (cheap — four small Firestore queries) and will move to session-cache
 * (campaign.settings.session_cache) in Phase 7 polish.
 *
 * Without this layer, `heroism: 7` renders as a bare number in Block 1
 * with no attached "what 7 means in narrative practice" — KA falls back
 * to base-training intuition for the axes, which drifts toward generic
 * anime prose over hundreds of turns. With it, every axis carries a
 * prescriptive directive.
 */

// ---------------------------------------------------------------------------
// Primitive getters — single (category, axis, value) lookup.
// ---------------------------------------------------------------------------

async function lookupContent(
  firestore: Firestore,
  category: string,
  axis: string | null,
  valueKey: string,
): Promise<string | null> {
  // Firestore can't filter on `null` with `==` if the field is missing;
  // explicit `null` storage in the indexer keeps these where-clauses simple.
  const snap = await firestore
    .collection(COL.ruleLibraryChunks)
    .where("category", "==", category)
    .where("axis", "==", axis)
    .where("valueKey", "==", valueKey)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const data = snap.docs[0]?.data();
  const content = data?.content;
  return typeof content === "string" ? content : null;
}

export async function getDnaGuidance(
  firestore: Firestore,
  axis: keyof DNAScales,
  value: number,
): Promise<string | null> {
  // Content is authored at 1 / 5 / 10; snap to the nearest of those.
  // v3-parity: stepped directives let three points cover the range
  // without needing to author every integer. Callers' actual DNA
  // value is still narrated faithfully in Block 1; the guidance is
  // interpretive.
  const snap = value <= 2 ? "1" : value >= 8 ? "10" : "5";
  return lookupContent(firestore, "dna", axis, snap);
}

export async function getCompositionGuidance(
  firestore: Firestore,
  axis: keyof Composition,
  valueKey: string,
): Promise<string | null> {
  return lookupContent(firestore, "composition", axis, valueKey);
}

export async function getPowerTierGuidance(
  firestore: Firestore,
  tier: string,
): Promise<string | null> {
  return lookupContent(firestore, "power_tier", null, tier);
}

export async function getArchetypeGuidance(
  firestore: Firestore,
  archetype: string,
): Promise<string | null> {
  return lookupContent(firestore, "archetype", null, archetype);
}

/**
 * Beat-craft guidance for the current arc phase. v3's Approach D — per-
 * phase writing-craft directives. Block 4's arc_phase value on its own
 * just renders an enum; this getter fetches the prose about HOW to
 * narrate that phase (setup orients, complication destabilizes, etc.).
 * Phase 7 polish — MINOR #18.
 */
export async function getBeatCraftGuidance(
  firestore: Firestore,
  arcPhase: string,
): Promise<string | null> {
  return lookupContent(firestore, "beat_craft", null, arcPhase);
}

// ---------------------------------------------------------------------------
// Session-level bundle assembly.
// ---------------------------------------------------------------------------

interface SessionBundleInput {
  profile: Profile;
  activeDna?: DNAScales;
  activeComposition?: Composition;
  characterPowerTier?: string | null;
  campaignId: string;
}

/**
 * Pull all rule-library chunks relevant to THIS session in batched
 * queries (one per category: dna, composition, power_tier, archetype),
 * then assemble a Markdown bundle KA reads at session start. Missing
 * content degrades gracefully — an axis with no chunk for its current
 * value simply omits that axis's line. The bundle never errors.
 *
 * Firestore note: there's no `IN (...)` over arbitrary tuple lookups.
 * For the per-axis DNA/composition pass we pull every entry of the
 * category once and filter in memory — the rule library is a small
 * fixed corpus (low hundreds of docs) so the over-fetch is cheap.
 */
export async function assembleSessionRuleLibraryGuidance(
  firestore: Firestore,
  input: SessionBundleInput,
): Promise<string> {
  const activeDna = input.activeDna ?? input.profile.canonical_dna;
  const activeComposition = input.activeComposition ?? input.profile.canonical_composition;

  // --- DNA section ---
  const dnaAxes = Object.keys(activeDna) as Array<keyof DNAScales>;
  const dnaLookups = dnaAxes.map((axis) => {
    const value = activeDna[axis];
    const snap = value <= 2 ? "1" : value >= 8 ? "10" : "5";
    return { axis: axis as string, valueKey: snap };
  });
  const dnaRows = await fetchBatch(firestore, "dna");
  const dnaSection = renderSection(
    "DNA axes — tonal pressures for this campaign",
    dnaAxes.map((axis) => {
      const valueKey = dnaLookups.find((l) => l.axis === axis)?.valueKey ?? "5";
      const row = dnaRows.find((r) => r.axis === axis && r.valueKey === valueKey);
      if (!row) return null;
      return {
        key: `${axis} = ${activeDna[axis]}`,
        content: row.content,
      };
    }),
  );

  // --- Composition section ---
  const compositionAxes = Object.keys(activeComposition) as Array<keyof Composition>;
  const compositionRows = await fetchBatch(firestore, "composition");
  const compositionSection = renderSection(
    "Composition — narrative framing for this campaign",
    compositionAxes.map((axis) => {
      const valueKey = String(activeComposition[axis]);
      const row = compositionRows.find((r) => r.axis === axis && r.valueKey === valueKey);
      if (!row) return null;
      return {
        key: `${axis}: ${valueKey}`,
        content: row.content,
      };
    }),
  );

  // --- Power tier section (character + in-play NPCs for context) ---
  const tierKeys = new Set<string>();
  if (input.characterPowerTier) tierKeys.add(input.characterPowerTier);
  const npcsSnap = await firestore
    .collection(COL.campaigns)
    .doc(input.campaignId)
    .collection(CAMPAIGN_SUB.npcs)
    .limit(100)
    .get();
  for (const d of npcsSnap.docs) {
    const tier = d.data().powerTier;
    if (typeof tier === "string" && tier.length > 0) tierKeys.add(tier);
  }
  const tierRows = tierKeys.size === 0 ? [] : await fetchBatch(firestore, "power_tier");
  const tierSection = renderSection(
    "Power tiers in play",
    [...tierKeys].map((tier) => {
      const row = tierRows.find((r) => r.valueKey === tier);
      if (!row) return null;
      return { key: tier, content: row.content };
    }),
  );

  // --- Ensemble archetypes section (from NPC catalog, if any) ---
  const archetypes = new Set<string>();
  for (const d of npcsSnap.docs) {
    const arche = d.data().ensembleArchetype;
    if (typeof arche === "string" && arche.length > 0) archetypes.add(arche);
  }
  const archetypeRows = archetypes.size === 0 ? [] : await fetchBatch(firestore, "archetype");
  const archetypeSection = renderSection(
    "Ensemble archetypes in play",
    [...archetypes].map((arch) => {
      const row = archetypeRows.find((r) => r.valueKey === arch);
      if (!row) return null;
      return { key: arch, content: row.content };
    }),
  );

  const sections = [dnaSection, compositionSection, tierSection, archetypeSection].filter(
    (s) => s.length > 0,
  );
  return sections.join("\n\n---\n\n");
}

/**
 * Pull every chunk in a category. The rule library is a small fixed
 * corpus (low hundreds of docs across all categories), so the
 * over-fetch in exchange for a single round-trip per category is
 * cheap. Bounded at 500.
 */
async function fetchBatch(
  firestore: Firestore,
  category: string,
): Promise<Array<{ axis: string | null; valueKey: string | null; content: string }>> {
  const snap = await firestore
    .collection(COL.ruleLibraryChunks)
    .where("category", "==", category)
    .limit(500)
    .get();
  return snap.docs.map((d) => {
    const r = d.data();
    return {
      axis: typeof r.axis === "string" ? r.axis : null,
      valueKey: typeof r.valueKey === "string" ? r.valueKey : null,
      content: typeof r.content === "string" ? r.content : "",
    };
  });
}

function renderSection(
  heading: string,
  entries: Array<{ key: string; content: string } | null>,
): string {
  const live = entries.filter((e): e is { key: string; content: string } => e !== null);
  if (live.length === 0) return "";
  const body = live.map((e) => `**${e.key}**\n${e.content.trim()}`).join("\n\n");
  return `### ${heading}\n\n${body}`;
}
