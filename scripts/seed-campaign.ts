/**
 * Seed / re-seed the Bebop campaign for one user.
 *
 * You usually don't need to run this — the sign-in flow
 * (POST /api/auth/session) lazy-seeds on first sign-in, so signing in
 * at prod is enough to land on a playable campaign. This script exists
 * for:
 *   - re-seeding from dev when the fixture changes (updates the profile
 *     doc; leaves existing campaign state alone)
 *   - manually creating a campaign for a user whose lazy-seed didn't
 *     fire (rare — sign-in error mid-flight, etc.)
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
