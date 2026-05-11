/**
 * Campaign archive pass — purges soft-deleted campaigns whose
 * `deletedAt` is older than the grace window (default 14 days).
 * Companion to `scripts/users-hard-delete.ts`: that script handles
 * full-account deletion (users + all their campaigns); this one
 * handles per-campaign abandonment (`abandonCampaign` /
 * `redoSessionZero`) for live users.
 *
 * Per-campaign purge mirrors `users-hard-delete`:
 *   - Delete every doc in every subcollection (CAMPAIGN_SUB.* — 15
 *     of them at M3): turns, characters, contextBlocks, npcs,
 *     locations, factions, relationshipEvents, semanticMemories,
 *     foreshadowingSeeds, voicePatterns, directorNotes,
 *     spotlightDebt, arcPlanHistory, sessionZero,
 *     openingStatePackages.
 *   - Delete the campaign doc itself.
 *   - Best-effort Algolia cleanup (no-op today; placeholder for
 *     future delete-by-filter on turn/profile indices).
 *
 * Idempotent — re-running on the same campaign is a no-op (campaign
 * doc already gone → query returns nothing). Safe to dedup against
 * `users-hard-delete`: if a user soft-deleted both their account and
 * a campaign, whichever cron fires first purges the campaign; the
 * other finds nothing.
 *
 * Cloud Scheduler integration deferred (M2.5 residuals plan §3) —
 * lands at M3.5+ admin surface or M9 billing-driven retention. Today
 * it's a manual run.
 *
 * Usage:
 *   pnpm campaigns:archive --dry-run
 *   pnpm campaigns:archive --confirm
 *   pnpm campaigns:archive --days 1 --confirm   # tighter window for testing
 *
 * Safety: refuses to run without --confirm unless --dry-run is set.
 */
import { isAlgoliaConfigured } from "@/lib/algolia/client";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import type { CollectionReference, DocumentReference, Query } from "firebase-admin/firestore";

const DEFAULT_DAYS = 14;
const ALL_CAMPAIGN_SUBCOLLECTIONS = Object.values(CAMPAIGN_SUB);

interface Args {
  days: number;
  dryRun: boolean;
  confirm: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { days: DEFAULT_DAYS, dryRun: false, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--days") {
      const next = argv[i + 1];
      if (next) {
        args.days = Number.parseInt(next, 10);
        i += 1;
      }
    }
  }
  return args;
}

async function deleteEverythingInCollection(col: CollectionReference): Promise<number> {
  let deleted = 0;
  for (;;) {
    const snap = await col.limit(250).get();
    if (snap.empty) break;
    const batch = col.firestore.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    deleted += snap.size;
  }
  return deleted;
}

async function purgeCampaign(campaignRef: DocumentReference): Promise<number> {
  let total = 0;
  for (const sub of ALL_CAMPAIGN_SUBCOLLECTIONS) {
    const n = await deleteEverythingInCollection(campaignRef.collection(sub));
    total += n;
  }
  await campaignRef.delete();
  return total + 1;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.dryRun && !args.confirm) {
    console.error(
      "Refusing to run without --confirm. Pass --dry-run to preview, or --confirm to actually delete.",
    );
    process.exit(1);
  }

  const firestore = getFirebaseFirestore();
  const cutoffMs = Date.now() - args.days * 24 * 60 * 60 * 1000;
  console.log(
    `→ Looking for campaigns with deletedAt < ${new Date(cutoffMs).toISOString()} (${args.days}d ago)…`,
  );

  // Composite inequality with null exclusion is annoying — pull everything
  // where deletedAt < cutoff (null is naturally excluded since null is not
  // < anything) and act in code. Matches the pattern in users-hard-delete.
  const campaignsQuery: Query = firestore
    .collection(COL.campaigns)
    .where("deletedAt", "<", new Date(cutoffMs));
  const snap = await campaignsQuery.get();
  if (snap.empty) {
    console.log("✓ No campaigns past the grace window. Nothing to delete.");
    process.exit(0);
  }

  console.log(`→ Found ${snap.size} campaign(s) to purge.`);

  let totalDocs = 0;
  let algoliaRecordsDeleted = 0;

  for (const campDoc of snap.docs) {
    const campId = campDoc.id;
    const ownerUid = (campDoc.data().ownerUid as string | undefined) ?? "(unknown)";
    console.log(`  campaign ${campId} (owner ${ownerUid}): purging subcollections…`);
    if (args.dryRun) continue;

    const docsDeleted = await purgeCampaign(campDoc.ref);
    totalDocs += docsDeleted;

    // Best-effort Algolia cleanup. Turn records are keyed by the
    // Firestore turn ids that are now gone; a future delete-by-filter
    // (campaignId=X) on the turn index would clean orphans. Acceptable
    // orphan today — mirrors users-hard-delete's decision.
    if (isAlgoliaConfigured() && !args.dryRun) {
      algoliaRecordsDeleted += 0;
    }
  }

  console.log(
    `✓ ${args.dryRun ? "[dry-run] would have deleted" : "Deleted"} ${snap.size} campaign(s), ${totalDocs} doc(s) total, ${algoliaRecordsDeleted} Algolia record(s).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
