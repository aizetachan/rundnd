import { TURNS_INDEX_NAME, getAlgoliaAdmin, isAlgoliaConfigured } from "./client";

/**
 * Algolia index shape for turns. Document key is the Firestore turn id
 * so re-indexing the same turn (idempotent retry) overwrites in place.
 *
 * `narrativeText` and `summary` are the fields we actually search; the
 * other fields are filterable / displayable metadata. The campaignId
 * filter is critical — without it, recall_scene from one player's
 * campaign could surface another player's turns.
 */
export interface TurnRecord {
  objectID: string; // == Firestore turn id
  campaignId: string;
  turnNumber: number;
  narrativeText: string;
  summary?: string | null;
  playerMessage?: string;
  verdictKind?: string;
  createdAtMs?: number; // for orderBy in queries
}

/**
 * Push a turn into the Algolia index. Safe to call from any post-turn
 * code path — caller decides whether to await or fire-and-forget.
 *
 * No-ops when Algolia isn't configured (e.g. local dev without keys
 * in .env.local) so the turn pipeline never blocks on indexing.
 */
export async function indexTurn(record: TurnRecord): Promise<void> {
  if (!isAlgoliaConfigured()) return;
  try {
    const client = await getAlgoliaAdmin();
    await client.saveObject({
      indexName: TURNS_INDEX_NAME,
      body: record,
    });
  } catch (err) {
    // Indexing failure must not fail the turn the user already saw.
    console.warn("[algolia] indexTurn failed", {
      objectID: record.objectID,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface TurnSearchHit {
  turnId: string;
  turnNumber: number;
  narrativeText: string;
  summary: string | null;
  score: number; // 0..1; Algolia _rankingInfo-derived
  excerpt: string;
}

/**
 * Search turns within a campaign. Returns up to `limit` hits ranked by
 * Algolia's relevance + recency. Returns empty array (not throw) when
 * Algolia isn't configured — caller can fall back to a degraded path.
 */
export async function searchTurns(
  campaignId: string,
  query: string,
  limit = 5,
  turnRange?: { start?: number; end?: number },
): Promise<TurnSearchHit[]> {
  if (!isAlgoliaConfigured()) return [];
  if (!query.trim()) return [];

  const filterParts = [`campaignId:${JSON.stringify(campaignId)}`];
  if (turnRange?.start !== undefined) {
    filterParts.push(`turnNumber >= ${turnRange.start}`);
  }
  if (turnRange?.end !== undefined) {
    filterParts.push(`turnNumber <= ${turnRange.end}`);
  }

  try {
    const client = await getAlgoliaAdmin();
    const result = await client.searchSingleIndex({
      indexName: TURNS_INDEX_NAME,
      searchParams: {
        query,
        hitsPerPage: limit,
        filters: filterParts.join(" AND "),
        attributesToSnippet: ["narrativeText:30"],
        snippetEllipsisText: "…",
        getRankingInfo: true,
      },
    });

    return (result.hits ?? []).map((hit: Record<string, unknown>) => {
      const snippet = (hit._snippetResult as { narrativeText?: { value?: string } } | undefined)
        ?.narrativeText?.value;
      const ranking = hit._rankingInfo as { firstMatchedWord?: number } | undefined;
      // Algolia's ranking signals are arbitrary integers; collapse to a
      // 0..1 range for downstream callers that expect a score. A hit is
      // a hit; the exact ordering matters more than the absolute number.
      const score = ranking ? 1 / (1 + (ranking.firstMatchedWord ?? 0)) : 1;
      return {
        turnId: String(hit.objectID),
        turnNumber: Number(hit.turnNumber ?? 0),
        narrativeText: String(hit.narrativeText ?? ""),
        summary: hit.summary ? String(hit.summary) : null,
        score,
        excerpt: snippet ?? String(hit.narrativeText ?? "").slice(0, 200),
      };
    });
  } catch (err) {
    console.warn("[algolia] searchTurns failed", {
      campaignId,
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Configure searchable attributes + ranking on the turns index.
 * Idempotent — call once during setup or whenever the schema changes.
 */
export async function configureTurnsIndex(): Promise<void> {
  if (!isAlgoliaConfigured()) {
    throw new Error("Algolia not configured");
  }
  const client = await getAlgoliaAdmin();
  await client.setSettings({
    indexName: TURNS_INDEX_NAME,
    indexSettings: {
      searchableAttributes: ["narrativeText", "summary", "playerMessage"],
      attributesForFaceting: ["filterOnly(campaignId)", "filterOnly(turnNumber)"],
      customRanking: ["desc(turnNumber)"],
      // Snippet length comes from search-time params; this just sets defaults.
      attributesToSnippet: ["narrativeText:30"],
    },
  });
}
