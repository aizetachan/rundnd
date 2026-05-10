import { CAMPAIGN_SUB, COL, SESSION_ZERO_DOC_ID } from "@/lib/firestore";
import { anthropicFallbackConfig } from "@/lib/providers";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Find the user's active Session Zero campaign, or create a new one.
 *
 * "Active" = a campaign with phase ∈ {session_zero, sz} whose
 * sessionZero/state doc is in `not_started` or `in_progress`. Sub 5
 * will surface the resume/abandon/redo controls; for sub 3 we just
 * pick the most recently created in-flight SZ.
 *
 * Idempotent: a returning user with an in-progress SZ gets the same
 * campaign back. A user with no in-progress SZ gets a fresh campaign
 * + SZ doc bootstrapped at phase=in_progress, ready for the conductor.
 *
 * Why a campaign-level phase ("session_zero") AND a SZ-doc-level phase
 * ("in_progress"): the campaign-level phase determines which UI
 * surface routes to (campaigns list filters out SZ-phase campaigns
 * from the playable list); the doc-level phase tracks the
 * conversation's lifecycle and gates `finalize_session_zero`.
 *
 * Race caveat: the read + create here are not transactional, so two
 * concurrent /sz hits (e.g. CTA double-click, React Strict Mode dev
 * remount) can produce two campaigns. Acceptable at M2 first ship —
 * /sz is gated behind a single-click CTA in the normal flow. Sub 5
 * surfaces a "continue Session Zero" affordance that makes the
 * find-the-existing-one path observable; promote to a transactional
 * find-or-create against a stable `sessionZero-active-{userId}` key
 * if the duplicate-campaign rate shows up in PostHog.
 */
export async function ensureSessionZeroCampaign(
  firestore: Firestore,
  userId: string,
): Promise<{ campaignId: string; created: boolean }> {
  // Reuse the (ownerUid, deletedAt, createdAt) composite index already
  // declared for the campaigns list. Filtering by phase in code is
  // cheaper than declaring a new (ownerUid, phase, deletedAt, createdAt)
  // index for what is at most a few campaigns per user.
  const campaignsCol = firestore.collection(COL.campaigns);
  const recent = await campaignsCol
    .where("ownerUid", "==", userId)
    .where("deletedAt", "==", null)
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();

  for (const doc of recent.docs) {
    const data = doc.data();
    if (data.phase !== "session_zero" && data.phase !== "sz") continue;
    const szRef = doc.ref.collection(CAMPAIGN_SUB.sessionZero).doc(SESSION_ZERO_DOC_ID);
    const szSnap = await szRef.get();
    if (!szSnap.exists) continue;
    const szPhase = szSnap.data()?.phase;
    if (szPhase === "not_started" || szPhase === "in_progress") {
      return { campaignId: doc.id, created: false };
    }
  }

  // No in-flight SZ — bootstrap a new campaign + state doc. The
  // campaign-level settings carry the per-campaign provider/tier_models
  // so the conductor's modelContext resolves the same way the gameplay
  // turn workflow does. world_state / active_dna / active_composition
  // stay null until HandoffCompiler (sub 4) writes them.
  const providerConfig = anthropicFallbackConfig();
  const campaignRef = await campaignsCol.add({
    ownerUid: userId,
    name: "(untitled — Session Zero)",
    phase: "session_zero",
    profileRefs: [],
    settings: {
      provider: providerConfig.provider,
      tier_models: providerConfig.tier_models,
      overrides: [],
    },
    createdAt: FieldValue.serverTimestamp(),
    deletedAt: null,
  });

  const now = new Date();
  await campaignRef
    .collection(CAMPAIGN_SUB.sessionZero)
    .doc(SESSION_ZERO_DOC_ID)
    .set({
      campaignId: campaignRef.id,
      ownerUid: userId,
      phase: "in_progress",
      profile_refs: [],
      canonicality_mode: null,
      character_draft: {
        name: null,
        concept: null,
        power_tier: null,
        abilities: [],
        appearance: null,
        personality: null,
        backstory: null,
        voice_notes: null,
      },
      conversation_history: [],
      starting_location: null,
      starting_situation: null,
      hard_requirements_met: {
        has_profile_ref: false,
        has_canonicality_mode: false,
        has_character_name: false,
        has_character_concept: false,
        has_starting_situation: false,
      },
      blocking_issues: [],
      rolling_summary: "",
      handoff_started_at: null,
      createdAt: now,
      updatedAt: FieldValue.serverTimestamp(),
    });

  return { campaignId: campaignRef.id, created: true };
}
