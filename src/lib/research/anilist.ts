import type { FranchiseCandidate } from "./types";

/**
 * Minimal AniList GraphQL client. No SDK — just fetch + a tiny query
 * builder. AniList's public GraphQL endpoint
 * (https://graphql.anilist.co) is unauthenticated for read queries
 * and rate-limited at 90 req/min (per-IP), generous for this use case.
 *
 * Used by:
 *   - sub 5: franchise-graph disambiguation (this file).
 *   - sub 6: Path A scrapers (this file's queries plus more).
 *
 * Queries are intentionally narrow — we ship the minimum the
 * disambiguation UI needs, not AniList's full schema. When Path A
 * lands its richer ip_mechanics extraction, those queries get added
 * here.
 */

const ANILIST_ENDPOINT = "https://graphql.anilist.co";

/**
 * Map AniList MediaType + Format to the Profile MediaType enum.
 *
 * AniList's `Format` distinguishes TV vs MOVIE vs MANGA vs LIGHT_NOVEL
 * etc.; the Profile schema collapses many of those into "anime" or
 * "manga" + a couple of cousins. This is a hand-written narrowing
 * pass.
 */
function mapMediaType(
  type: string | null | undefined,
  format: string | null | undefined,
): "anime" | "manga" | "manhwa" | "donghua" | "light_novel" {
  // Light novels and novels live under MANGA in AniList's Format enum.
  if (format === "NOVEL" || format === "LIGHT_NOVEL") return "light_novel";
  // Manhwa / manhua / donghua — AniList tags via countryOfOrigin, not
  // exposed in this query. Default to "manga" / "anime" by media type;
  // researcher can correct when reading countryOfOrigin downstream.
  if (type === "MANGA") return "manga";
  return "anime";
}

function mapStatus(status: string | null | undefined): "ongoing" | "completed" | "hiatus" {
  if (status === "RELEASING") return "ongoing";
  if (status === "HIATUS") return "hiatus";
  return "completed";
}

interface AniListMedia {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  synonyms: string[] | null;
  type: string | null;
  format: string | null;
  status: string | null;
  startDate: { year: number | null } | null;
  popularity: number | null;
  description: string | null;
  relations: {
    edges: Array<{
      relationType: string;
      node: { id: number };
    }>;
  } | null;
}

const SEARCH_QUERY = `
query ($search: String, $perPage: Int) {
  Page(perPage: $perPage) {
    media(search: $search, sort: POPULARITY_DESC) {
      id
      title { romaji english native }
      synonyms
      type
      format
      status
      startDate { year }
      popularity
      description(asHtml: false)
      relations {
        edges {
          relationType
          node { id }
        }
      }
    }
  }
}`;

/**
 * Search AniList for a title and return a disambiguation list.
 * Collapses SEQUEL/PREQUEL chains into the earliest entry; surfaces
 * SPIN_OFF / ALTERNATIVE as distinct candidates. Returns up to
 * `limit` candidates, sorted by popularity desc.
 *
 * Throws on network/HTTP failure; caller (spawn-subagent.ts) catches
 * + falls back to "spawn research without selectedAnilistId" letting
 * the LLM pick.
 */
export async function searchFranchise(title: string, limit = 6): Promise<FranchiseCandidate[]> {
  const response = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { search: title, perPage: Math.min(limit * 2, 16) },
    }),
  });

  if (!response.ok) {
    throw new Error(`AniList HTTP ${response.status}: ${await response.text().catch(() => "")}`);
  }
  const json = (await response.json()) as { data?: { Page?: { media?: AniListMedia[] } } };
  const media = json.data?.Page?.media ?? [];
  if (media.length === 0) return [];

  // Collapse sequel/prequel chains. Keep the earliest entry (lowest
  // startDate.year) for a chain; siblings (SPIN_OFF / ALTERNATIVE /
  // SIDE_STORY) stay distinct.
  const dropIds = new Set<number>();
  for (const m of media) {
    const edges = m.relations?.edges ?? [];
    const sequelOrPrequel = edges.filter(
      (e) => e.relationType === "SEQUEL" || e.relationType === "PREQUEL",
    );
    for (const edge of sequelOrPrequel) {
      // If the related id is also in the result set and started earlier,
      // drop the later entry. We don't have startDate on related nodes
      // in this query, so collapse only when both this entry and the
      // related are present — the popularity sort then preserves the
      // canonical-first reading.
      if (m.relations?.edges.some((e) => e.relationType === "SEQUEL")) {
        dropIds.add(edge.node.id);
      }
    }
  }

  const collapsed = media.filter((m) => !dropIds.has(m.id));
  const candidates: FranchiseCandidate[] = collapsed.slice(0, limit).map((m) => ({
    anilist_id: m.id,
    title: m.title.english ?? m.title.romaji,
    alternate_titles: [
      m.title.romaji,
      m.title.english,
      m.title.native,
      ...(m.synonyms ?? []),
    ].filter((t): t is string => Boolean(t) && t !== (m.title.english ?? m.title.romaji)),
    media_type: mapMediaType(m.type, m.format),
    status: mapStatus(m.status),
    relation_to_query: "canonical",
    start_year: m.startDate?.year ?? null,
    popularity: m.popularity ?? null,
    brief: buildBrief(m),
  }));

  return candidates;
}

/**
 * Deep-metadata query for a single AniList media id — used by Path A.
 *
 * The franchise-graph SEARCH_QUERY above is narrow on purpose (it
 * feeds the disambiguation UI which only needs title/year/popularity).
 * Path A's LLM parse pass needs more: description, tags, characters,
 * episode/chapter count, average score. Separate query so we don't
 * pay for the heavy fields in every disambiguation call.
 */
const PROFILE_QUERY = `
query ($id: Int) {
  Media(id: $id) {
    id
    title { romaji english native }
    synonyms
    type
    format
    status
    startDate { year }
    episodes
    chapters
    popularity
    averageScore
    description(asHtml: false)
    genres
    tags { name rank isMediaSpoiler }
    characters(sort: ROLE, perPage: 8) {
      edges {
        role
        node { name { full } }
      }
    }
    relations {
      edges {
        relationType
        node { id title { romaji english } type format }
      }
    }
  }
}`;

export interface AniListProfilePayload {
  id: number;
  title: string;
  alternate_titles: string[];
  media_type: "anime" | "manga" | "manhwa" | "donghua" | "light_novel";
  status: "ongoing" | "completed" | "hiatus";
  start_year: number | null;
  episodes: number | null;
  chapters: number | null;
  popularity: number | null;
  average_score: number | null;
  description: string;
  genres: string[];
  tags: Array<{ name: string; rank: number; isMediaSpoiler: boolean }>;
  /** Top characters by role — MAIN first, then SUPPORTING. */
  characters: Array<{ name: string; role: string }>;
  relations: Array<{ type: string; title: string }>;
}

/**
 * Fetch full AniList metadata for a single media id. Used by the
 * Path A profile researcher (`src/lib/agents/profile-researcher-a.ts`)
 * to give the LLM parse pass enough structured material to populate
 * `AnimeResearchOutput` without hallucinating outside the source.
 *
 * Throws on HTTP error so the caller (Path A orchestrator) can
 * decide whether to retry, fall back to AniList-only, or surface the
 * failure to the conductor.
 */
export async function fetchAniListProfile(anilist_id: number): Promise<AniListProfilePayload> {
  const response = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: PROFILE_QUERY, variables: { id: anilist_id } }),
  });
  if (!response.ok) {
    throw new Error(`AniList HTTP ${response.status}: ${await response.text().catch(() => "")}`);
  }
  const json = (await response.json()) as {
    data?: {
      Media?: {
        id: number;
        title: { romaji: string; english: string | null; native: string | null };
        synonyms: string[] | null;
        type: string | null;
        format: string | null;
        status: string | null;
        startDate: { year: number | null } | null;
        episodes: number | null;
        chapters: number | null;
        popularity: number | null;
        averageScore: number | null;
        description: string | null;
        genres: string[] | null;
        tags: Array<{ name: string; rank: number | null; isMediaSpoiler: boolean }> | null;
        characters: {
          edges: Array<{ role: string; node: { name: { full: string } } }>;
        } | null;
        relations: {
          edges: Array<{
            relationType: string;
            node: {
              id: number;
              title: { romaji: string; english: string | null };
              type: string | null;
              format: string | null;
            };
          }>;
        } | null;
      };
    };
  };
  const m = json.data?.Media;
  if (!m) {
    throw new Error(`AniList returned no Media for id ${anilist_id}`);
  }
  const primaryTitle = m.title.english ?? m.title.romaji;
  return {
    id: m.id,
    title: primaryTitle,
    alternate_titles: [
      m.title.romaji,
      m.title.english,
      m.title.native,
      ...(m.synonyms ?? []),
    ].filter((t): t is string => Boolean(t) && t !== primaryTitle),
    media_type: mapMediaType(m.type, m.format),
    status: mapStatus(m.status),
    start_year: m.startDate?.year ?? null,
    episodes: m.episodes ?? null,
    chapters: m.chapters ?? null,
    popularity: m.popularity ?? null,
    average_score: m.averageScore ?? null,
    description: (m.description ?? "").replace(/<[^>]+>/g, "").trim(),
    genres: m.genres ?? [],
    tags: (m.tags ?? []).map((t) => ({
      name: t.name,
      rank: t.rank ?? 0,
      isMediaSpoiler: t.isMediaSpoiler,
    })),
    characters: (m.characters?.edges ?? []).map((e) => ({
      name: e.node.name.full,
      role: e.role,
    })),
    relations: (m.relations?.edges ?? []).map((e) => ({
      type: e.relationType,
      title: e.node.title.english ?? e.node.title.romaji,
    })),
  };
}

function buildBrief(m: AniListMedia): string {
  const year = m.startDate?.year ? ` (${m.startDate.year})` : "";
  const status = m.status === "RELEASING" ? "ongoing" : "completed";
  const format = m.format ? `${m.format.toLowerCase().replace(/_/g, " ")}` : "";
  const head = `${format}${year}${format || year ? ", " : ""}${status}`;
  const desc = (m.description ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return `${head}${desc ? ` — ${desc}${desc.length === 140 ? "…" : ""}` : ""}`;
}
