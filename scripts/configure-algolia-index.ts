/**
 * One-shot setup script for the Algolia `turns` index:
 *   1. Pushes the searchable attributes / faceting / custom ranking
 *      configuration to Algolia.
 *   2. Backfills every existing turn from Firestore into Algolia so
 *      `recall_scene` can find them on the first call (otherwise the
 *      indexer only kicks in for *new* turns from this point forward).
 *
 * Idempotent — safe to re-run any time. saveObjects upserts by
 * objectID (= Firestore turn id).
 *
 * Usage (env vars loaded from .env.local via the script's --env-file flag):
 *   pnpm algolia:configure
 *
 * Or directly with tsx:
 *   tsx --env-file=.env.local scripts/configure-algolia-index.ts
 */
import { isAlgoliaConfigured } from "@/lib/algolia/client";
import { configureTurnsIndex, indexTurn } from "@/lib/algolia/turn-index";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";

async function main() {
  if (!isAlgoliaConfigured()) {
    console.error(
      "Algolia env vars missing. Need ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY, NEXT_PUBLIC_ALGOLIA_APP_ID, NEXT_PUBLIC_ALGOLIA_SEARCH_KEY in .env.local",
    );
    process.exit(1);
  }

  console.log("→ Configuring `turns` index (searchable attrs, ranking)…");
  await configureTurnsIndex();
  console.log("✓ Index settings updated.");

  console.log("→ Backfilling existing turns from Firestore…");
  const firestore = getFirebaseFirestore();
  const campaignsSnap = await firestore.collection(COL.campaigns).get();
  let totalTurns = 0;
  let totalSkipped = 0;

  for (const campaignDoc of campaignsSnap.docs) {
    const campaignId = campaignDoc.id;
    const turnsSnap = await campaignDoc.ref
      .collection(CAMPAIGN_SUB.turns)
      .orderBy("turnNumber", "asc")
      .get();
    if (turnsSnap.empty) continue;

    console.log(`  campaign ${campaignId}: ${turnsSnap.size} turns`);
    for (const turnDoc of turnsSnap.docs) {
      const data = turnDoc.data() as {
        turnNumber?: number;
        narrativeText?: string | null;
        summary?: string | null;
        playerMessage?: string;
        verdictKind?: string;
        createdAt?: { toMillis?: () => number };
      };
      // Skip turns with no narrative — recall_scene can't find them anyway,
      // and they'd just bloat the index quota.
      if (!data.narrativeText || data.narrativeText.trim().length === 0) {
        totalSkipped += 1;
        continue;
      }
      await indexTurn({
        objectID: turnDoc.id,
        campaignId,
        turnNumber: data.turnNumber ?? 0,
        narrativeText: data.narrativeText,
        summary: data.summary ?? null,
        playerMessage: data.playerMessage,
        verdictKind: data.verdictKind,
        createdAtMs: data.createdAt?.toMillis?.() ?? Date.now(),
      });
      totalTurns += 1;
    }
  }

  console.log(`✓ Backfill complete. Indexed ${totalTurns} turns; skipped ${totalSkipped} empty.`);
  console.log(
    "→ Verify in Algolia dashboard: https://dashboard.algolia.com → app rundnd → Indices → turns",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
