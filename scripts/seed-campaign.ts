/**
 * Seed / re-seed the Bebop campaign for one user.
 *
 * Since M2 Wave A sub 6 (auto-seed cutover), the sign-in flow no
 * longer lazy-seeds the Bebop campaign — fresh users land on
 * /campaigns empty and walk through Session Zero. This script is the
 * dev-debug entry point for:
 *   - re-seeding from dev when the profile fixture changes (updates
 *     the profile doc; leaves existing campaign state alone)
 *   - bootstrapping a Bebop demo campaign for an account that needs
 *     a known-good gameplay surface (smoke-testing /campaigns/[id]/play
 *     without going through the SZ conductor)
 *
 * Usage (with .env.local loaded):
 *   pnpm seed:campaign                            # seeds against first user
 *   pnpm seed:campaign --user-id <firebase-uid>   # seeds against a specific user
 */
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { seedBebopCampaign } from "@/lib/seed/bebop";

async function main() {
  const args = process.argv.slice(2);
  const userIdFlagIdx = args.indexOf("--user-id");
  const explicitUserId = userIdFlagIdx !== -1 ? args[userIdFlagIdx + 1] : undefined;

  let userId = explicitUserId;
  if (!userId) {
    const db = getFirebaseFirestore();
    const snap = await db.collection(COL.users).where("deletedAt", "==", null).limit(1).get();
    if (snap.empty) {
      console.error(
        "No users in Firestore. Sign in on the deployed app first (lazy-seed creates the user doc).",
      );
      process.exit(1);
    }
    const doc = snap.docs[0];
    if (!doc) {
      console.error("Snapshot reported non-empty but had no docs — race?");
      process.exit(1);
    }
    userId = doc.id;
    console.log(`Seeding against user: ${doc.data().email ?? "(no email)"} (${userId})`);
  }

  const result = await seedBebopCampaign(userId);
  console.log(
    result.created
      ? `Created campaign ${result.campaignId} for user ${userId}`
      : `Campaign already exists: ${result.campaignId} (left alone)`,
  );
  console.log(`Visit /campaigns/${result.campaignId}/play to start.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
