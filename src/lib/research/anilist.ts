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
