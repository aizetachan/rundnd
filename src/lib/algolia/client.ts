/**
 * Algolia client singletons. Replaces the Postgres tsvector full-text
 * search that backed `recall_scene` before M0.5. The Build (free) tier
 * covers ~10K records + 10K searches/month — plenty for testing.
 *
 * The `algoliasearch` SDK is dynamically imported on first access so
 * the dependency doesn't end up in test-time module graphs that don't
 * touch Algolia at all (vitest contamination + slower startup).
 */

type AlgoliaClient = Awaited<ReturnType<typeof loadSdk>>;

async function loadSdk() {
  const { algoliasearch } = await import("algoliasearch");
  return algoliasearch;
}

let _admin: ReturnType<AlgoliaClient> | undefined;
let _search: ReturnType<AlgoliaClient> | undefined;

export async function getAlgoliaAdmin(): Promise<ReturnType<AlgoliaClient>> {
  if (_admin) return _admin;
  const appId = process.env.ALGOLIA_APP_ID;
  const adminKey = process.env.ALGOLIA_ADMIN_KEY;
  if (!appId || !adminKey) {
    throw new Error(
      "ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY not configured — recall_scene needs Algolia for full-text search",
    );
  }
  const algoliasearch = await loadSdk();
  _admin = algoliasearch(appId, adminKey);
  return _admin;
}

export async function getAlgoliaSearch(): Promise<ReturnType<AlgoliaClient>> {
  if (_search) return _search;
  const appId = process.env.NEXT_PUBLIC_ALGOLIA_APP_ID;
  const searchKey = process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY;
  if (!appId || !searchKey) {
    throw new Error(
      "NEXT_PUBLIC_ALGOLIA_APP_ID / NEXT_PUBLIC_ALGOLIA_SEARCH_KEY not configured",
    );
  }
  const algoliasearch = await loadSdk();
  _search = algoliasearch(appId, searchKey);
  return _search;
}

/**
 * Returns true when Algolia is fully configured. recall-scene and the
 * indexer call this before touching the client so partial deployments
 * (no keys yet) gracefully fall back to the substring-degraded path
 * instead of throwing at request time.
 */
export function isAlgoliaConfigured(): boolean {
  return Boolean(
    process.env.ALGOLIA_APP_ID &&
      process.env.ALGOLIA_ADMIN_KEY &&
      process.env.NEXT_PUBLIC_ALGOLIA_APP_ID &&
      process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY,
  );
}

export const TURNS_INDEX_NAME = "turns";
