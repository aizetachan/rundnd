import { getAlgoliaAdmin, isAlgoliaConfigured } from "./client";

/**
 * Algolia integration for the `profiles` Firestore collection. Lets
 * the SessionZeroConductor's `searchProfileLibrary` tool find existing
 * Profiles by title / alternate_titles / slug fuzzy match before
 * spawning a research subagent.
 *
 * The index name is `profiles` (distinct from the `turns` index used
 * by recall_scene). Same Algolia app, separate index.
 */
const PROFILES_INDEX_NAME = "profiles";

/**
 * One Algolia record per Profile. `objectID` == Firestore doc id (slug)
 * so re-indexing is idempotent.
 */
export interface ProfileRecord {
  objectID: string; // == slug (e.g. "cowboy-bebop")
  slug: string;
  title: string;
  alternate_titles: string[];
  media_type: string;
  status: string;
  /** Free-form description Path A or B emits — useful for fuzzy retrieval
   *  when the player names something obliquely ("space cowboys") that
   *  doesn't match the title. */
  brief?: string;
  /** AniList numeric id when known (Path A populates; Path B may leave null). */
  anilist_id?: number | null;
  /** Mirror of profile.id (al_<n> when AniList-sourced; uuid otherwise). */
  profile_id?: string | null;
}

export interface ProfileSearchHit {
  slug: string;
  title: string;
  alternate_titles: string[];
  media_type: string;
  brief: string | null;
  anilist_id: number | null;
  /** Algolia derived 0..1 — 1.0 = exact title match, lower = fuzzy. */
  score: number;
}

/**
 * Index a Profile in Algolia. Idempotent — same slug overwrites in
 * place. No-ops when Algolia isn't configured (local dev partial).
 */
export async function indexProfile(record: ProfileRecord): Promise<void> {
  if (!isAlgoliaConfigured()) return;
  try {
    const client = await getAlgoliaAdmin();
    await client.saveObject({
      indexName: PROFILES_INDEX_NAME,
      body: record,
    });
  } catch (err) {
    console.warn("[algolia] indexProfile failed", {
      slug: record.slug,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fuzzy search the profiles index. Returns up to `limit` hits ranked
 * by Algolia's relevance + the descending custom-rank we set on the
 * index. Empty array on missing config (lets the conductor fall
 * through to research).
 */
export async function searchProfiles(query: string, limit = 5): Promise<ProfileSearchHit[]> {
  if (!isAlgoliaConfigured()) return [];
  if (!query.trim()) return [];

  try {
    const client = await getAlgoliaAdmin();
    const result = await client.searchSingleIndex({
      indexName: PROFILES_INDEX_NAME,
      searchParams: {
        query,
        hitsPerPage: limit,
        getRankingInfo: true,
      },
    });

    return (result.hits ?? []).map((hit: Record<string, unknown>) => {
      const ranking = hit._rankingInfo as { firstMatchedWord?: number } | undefined;
      // Mirror turn-index's collapse: 0..1 derived from firstMatchedWord
      // (lower distance = better hit). Identical-title hits score 1.0.
      const score = ranking ? 1 / (1 + (ranking.firstMatchedWord ?? 0)) : 1;
      return {
        slug: String(hit.objectID),
        title: String(hit.title ?? ""),
        alternate_titles: Array.isArray(hit.alternate_titles)
          ? (hit.alternate_titles as string[])
          : [],
        media_type: String(hit.media_type ?? ""),
        brief: hit.brief ? String(hit.brief) : null,
        anilist_id: typeof hit.anilist_id === "number" ? hit.anilist_id : null,
        score,
      };
    });
  } catch (err) {
    console.warn("[algolia] searchProfiles failed", {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * One-shot index settings — searchable attributes, custom ranking,
 * faceting. Idempotent. Run from `scripts/configure-algolia-profile-index.ts`.
 */
export async function configureProfilesIndex(): Promise<void> {
  if (!isAlgoliaConfigured()) {
    throw new Error("Algolia not configured");
  }
  const client = await getAlgoliaAdmin();
  await client.setSettings({
    indexName: PROFILES_INDEX_NAME,
    indexSettings: {
      searchableAttributes: ["title", "alternate_titles", "brief"],
      attributesForFaceting: ["filterOnly(media_type)", "filterOnly(status)"],
      customRanking: ["desc(anilist_id)"],
    },
  });
}
