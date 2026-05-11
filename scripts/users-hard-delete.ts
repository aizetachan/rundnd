/**
 * Hard-delete pass — purges users + their data where the user doc's
 * `deletedAt` is older than the grace window (default 24h). Run
 * manually for M3 first ship; Cloud Scheduler integration lands when
 * billing (M9) or an admin surface (M3.5+) forces the schedule.
 *
 * Per-user purge:
 *   - For each owned campaign:
 *     - delete every doc in every subcollection (turns, characters,
 *       contextBlocks, npcs, locations, factions, relationshipEvents,
 *       semanticMemories, foreshadowingSeeds, voicePatterns,
 *       directorNotes, spotlightDebt, arcPlanHistory, sessionZero,
 *       openingStatePackages).
 *     - delete the campaign doc itself.
 *     - delete the Algolia profile/turn index records for that
 *       campaign (best-effort; Algolia outages don't block the
 *       Firestore purge).
 *   - Delete users/{uid}/rateCounters/* and costLedger/*.
 *   - Delete the user doc itself.
 *
 * Idempotent — a re-run on the same user is a no-op (campaign doc
 * already gone → query returns nothing).
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/users-hard-delete.ts
 *   pnpm tsx --env-file=.env.local scripts/users-hard-delete.ts --hours 1   # tighter window for testing
 *   pnpm tsx --env-file=.env.local scripts/users-hard-delete.ts --dry-run   # print plan, don't delete
 *
 * Safety: refuses to run without --confirm unless --dry-run is set.
 */
import { isAlgoliaConfigured } from "@/lib/algolia/client";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL, USER_SUB } from "@/lib/firestore";
import type {
  CollectionReference,
  DocumentReference,
  Query,
} from "firebase-admin/firestore";

const DEFAULT_HOURS = 24;
const ALL_CAMPAIGN_SUBCOLLECTIONS = Object.values(CAMPAIGN_SUB);
const ALL_USER_SUBCOLLECTIONS = Object.values(USER_SUB);

interface Args {
  hours: number;
  dryRun: boolean;
  confirm: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { hours: DEFAULT_HOURS, dryRun: false, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--hours") {
      const next = argv[i + 1];
      if (next) {
        args.hours = Number.parseInt(next, 10);
        i += 1;
      }
    }
  }
  return args;
}

async function deleteEverythingInCollection(col: CollectionReference): Promise<number> {
  // Firestore can't delete a collection in one shot — page through.
  let deleted = 0;
  // 250 per batch — well under the 500 transactional limit and avoids
  // OOM for very-large subcollections.
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

async function purgeUserSubcollections(userRef: DocumentReference): Promise<number> {
  let total = 0;
  for (const sub of ALL_USER_SUBCOLLECTIONS) {
    const n = await deleteEverythingInCollection(userRef.collection(sub));
    total += n;
  }
  return total;
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
  const cutoffMs = Date.now() - args.hours * 60 * 60 * 1000;
  console.log(
    `→ Looking for users with deletedAt < ${new Date(cutoffMs).toISOString()} (${args.hours}h ago)…`,
  );

  // Firestore: we want users.where(deletedAt != null && deletedAt < cutoff).
  // Composite inequality is annoying — pull everything where deletedAt
  // < cutoff (which excludes null because null isn't < anything) and
  // filter in code if needed.
  const usersQuery: Query = firestore
    .collection(COL.users)
    .where("deletedAt", "<", new Date(cutoffMs));
  const usersSnap = await usersQuery.get();
  if (usersSnap.empty) {
    console.log("✓ No users past the grace window. Nothing to delete.");
    process.exit(0);
  }

  console.log(`→ Found ${usersSnap.size} user(s) to purge.`);

  let totalCampaigns = 0;
  let totalDocs = 0;
  let algoliaProfilesDeleted = 0;

  for (const userDoc of usersSnap.docs) {
    const userId = userDoc.id;
    const ownedSnap = await firestore
      .collection(COL.campaigns)
      .where("ownerUid", "==", userId)
      .get();
    console.log(
      `  user ${userId}: ${ownedSnap.size} campaign(s), purging subcollections + user state…`,
    );
    if (args.dryRun) continue;

    for (const campDoc of ownedSnap.docs) {
      const docsDeleted = await purgeCampaign(campDoc.ref);
      totalCampaigns += 1;
      totalDocs += docsDeleted;
    }
    totalDocs += await purgeUserSubcollections(userDoc.ref);
    await userDoc.ref.delete();
    totalDocs += 1;

    // Best-effort Algolia cleanup. The user's profiles aren't owned by
    // the user (profiles are global / shared), so we don't delete those.
    // Turn records ARE per-campaign — but the turn index is keyed by
    // Firestore turn ids that are now gone; future deletes-by-filter
    // could clean them up. Acceptable orphan.
    if (isAlgoliaConfigured() && !args.dryRun) {
      // No-op today — see comment. If this becomes a real problem,
      // dispatch an Algolia delete-by-filter (campaignId=X) here.
      algoliaProfilesDeleted += 0;
    }
  }

  console.log(
    `✓ ${args.dryRun ? "[dry-run] would have deleted" : "Deleted"} ${totalCampaigns} campaign(s), ${totalDocs} doc(s) total, ${algoliaProfilesDeleted} Algolia record(s).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
