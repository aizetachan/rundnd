/**
 * One-shot setup script for the Algolia `profiles` index:
 *   1. Pushes the searchable attributes / faceting / custom ranking
 *      configuration to Algolia.
 *   2. Backfills every existing Profile from Firestore into Algolia
 *      so `searchProfileLibrary` can find them on the first call.
 *
 * Idempotent — safe to re-run any time. saveObject upserts by
 * objectID (= the profile's slug).
 *
 * Usage:
 *   pnpm algolia:configure-profiles
 *
 * Or directly:
 *   tsx --env-file=.env.local scripts/configure-algolia-profile-index.ts
 */
import { isAlgoliaConfigured } from "@/lib/algolia/client";
import { configureProfilesIndex, indexProfile } from "@/lib/algolia/profile-index";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";

async function main() {
  if (!isAlgoliaConfigured()) {
    console.error(
      "Algolia env vars missing. Need ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY, NEXT_PUBLIC_ALGOLIA_APP_ID, NEXT_PUBLIC_ALGOLIA_SEARCH_KEY in .env.local",
    );
    process.exit(1);
  }

  console.log("→ Configuring `profiles` index (searchable attrs, ranking)…");
  await configureProfilesIndex();
  console.log("✓ Index settings updated.");

  console.log("→ Backfilling existing profiles from Firestore…");
  const firestore = getFirebaseFirestore();
  const profilesSnap = await firestore.collection(COL.profiles).get();
  let totalIndexed = 0;
  let totalSkipped = 0;

  for (const doc of profilesSnap.docs) {
    const data = doc.data() as {
      slug?: string;
      title?: string;
      mediaType?: string;
      content?: {
        alternate_titles?: string[];
        status?: string;
        anilist_id?: number | null;
        id?: string;
        ip_mechanics?: { combat_style?: string };
        director_personality?: string;
      } | null;
    };
    const slug = data.slug ?? doc.id;
    const title = data.title;
    if (!title) {
      totalSkipped += 1;
      continue;
    }
    const content = data.content ?? {};
    // brief — short string the conductor sees in search results.
    // Director personality is usually 3-5 sentences; trim to a sensible
    // preview length so the index doesn't bloat.
    const directorBrief = content.director_personality?.slice(0, 280) ?? null;
    await indexProfile({
      objectID: slug,
      slug,
      title,
      alternate_titles: content.alternate_titles ?? [],
      media_type: data.mediaType ?? "anime",
      status: content.status ?? "completed",
      brief: directorBrief ?? undefined,
      anilist_id: content.anilist_id ?? null,
      profile_id: content.id ?? null,
    });
    totalIndexed += 1;
  }

  console.log(
    `✓ Backfill complete. Indexed ${totalIndexed} profiles; skipped ${totalSkipped} without a title.`,
  );
  console.log(
    "→ Verify in Algolia dashboard: https://dashboard.algolia.com → app rundnd → Indices → profiles",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
