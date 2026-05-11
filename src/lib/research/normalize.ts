import type { Profile } from "@/lib/types/profile";
import type { AnimeResearchOutput } from "./types";

/**
 * Convert an AnimeResearchOutput (what a researcher subagent emits)
 * into a full Profile (what Firestore + downstream agents consume).
 *
 * Adds the deterministic bits the researcher must NOT generate:
 *   - `id` — `al_<anilist_id>` if AniList sourced; falls back to a
 *     slug-derived id when not.
 *   - `slug` — kebab-cased title used as the Firestore doc id and
 *     the Algolia objectID. The slug is the user-facing key (you
 *     reference it in `Campaign.profile_refs`).
 *
 * Keeps every Researcher-emitted field intact — this is a hydration
 * pass, not a sanitizer.
 */
export function normalizeAnimeResearchOutput(output: AnimeResearchOutput): {
  profile: Profile;
  slug: string;
} {
  const slug = slugify(output.title);

  const id = output.anilist_id ? `al_${output.anilist_id}` : `manual_${slug}`;

  // Convert v3-style related_franchise (string[]) → v4 Profile shape
  // (related_franchise: string, single value). Profile.related_franchise
  // expects a single string today; if research returns multiple, join
  // with commas. The shape is open for refactor when M3 widens it.
  const relatedFranchise = output.related_franchise.length
    ? output.related_franchise.join(", ")
    : undefined;

  // The Profile schema today doesn't carry research_confidence /
  // research_notes — those are eval/telemetry fields. They live on
  // the AnimeResearchOutput envelope only.
  const profile: Profile = {
    id,
    title: output.title,
    alternate_titles: output.alternate_titles,
    anilist_id: output.anilist_id ?? undefined,
    mal_id: output.mal_id ?? undefined,
    media_type: output.media_type,
    status: output.status,
    series_group: output.series_group ?? undefined,
    series_position: output.series_position ?? undefined,
    related_franchise: relatedFranchise,
    relation_type: output.relation_type,
    ip_mechanics: output.ip_mechanics,
    canonical_dna: output.canonical_dna,
    canonical_composition: output.canonical_composition,
    director_personality: output.director_personality,
  };

  return { profile, slug };
}

/**
 * Lowercase + replace non-alphanumerics with `-`. Cap length at 80.
 * Profile slug doubles as Firestore doc id and Algolia objectID, so
 * it has to satisfy both: ASCII-safe, no `/`, reasonable length.
 *
 * Same shape as `safeNameId` in `src/lib/firestore/ids.ts` but tighter
 * cap (titles are short; 80 is plenty). Not reusing the firestore one
 * because the cap difference matters for human-typed slugs ("cowboy-bebop"
 * not "cowboy-bebop-and-the-rest-of-this-very-long-canonical-title-...").
 */
export function slugify(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}
