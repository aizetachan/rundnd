import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { anthropicFallbackConfig } from "@/lib/providers";
import { Profile } from "@/lib/types/profile";
import { FieldValue } from "firebase-admin/firestore";
import jsYaml from "js-yaml";

/**
 * Reusable seed — Cowboy Bebop profile + Spike character + a playable
 * campaign. Invoked by `pnpm seed:campaign` (dev CLI) and by the
 * sign-in flow (POST /api/auth/session) so a player who's just signed
 * up lands on /campaigns with something to play immediately.
 *
 * Idempotent: upserts the profile by slug and creates the campaign
 * only if the user doesn't already have one named BEBOP_CAMPAIGN_NAME.
 */

const BEBOP_FIXTURE_PATH = join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml");

export const BEBOP_CAMPAIGN_NAME = "Bebop — Red Entry";
export const BEBOP_PROFILE_SLUG = "cowboy-bebop";

export const SPIKE_CHARACTER = {
  name: "Spike Spiegel",
  concept:
    "Ex-syndicate enforcer turned reluctant bounty hunter. Tall, lean, hair perpetually in his face. Moves like someone who's already resigned himself to dying and finds that funny. Carries a Jericho 941. Owes money.",
  power_tier: "T9",
  sheet: {
    available: true,
    name: "Spike Spiegel",
    concept: "Bounty hunter, ex-Red Dragon enforcer, Jeet Kune Do stylist.",
    power_tier: "T9",
    stats: { STR: 13, DEX: 16, CON: 12, INT: 13, WIS: 11, CHA: 14 },
    abilities: [
      {
        name: "Jeet Kune Do",
        description:
          "Fluid striking art. Reads openings fast; prefers to let the opponent commit then redirect.",
        limitations: "No supernatural enhancement. Spike bleeds like anyone else.",
      },
      {
        name: "Marksmanship (Jericho 941)",
        description: "Accurate under pressure; trick-shots in close quarters.",
        limitations: "Ammunition is finite. Shaky grouping beyond 40m.",
      },
    ],
    inventory: [
      { name: "Jericho 941", description: "Spike's pistol. 16+1 rounds." },
      { name: "Worn blue suit, yellow shirt", description: "His uniform." },
      { name: "Cigarettes (half pack)", description: "He'll finish it before the session ends." },
    ],
    stat_mapping: null,
    current_state: { hp: 30, status_effects: [] },
  },
} as const;

function loadBebopProfile(): Profile {
  const raw = readFileSync(BEBOP_FIXTURE_PATH, "utf8");
  return Profile.parse(jsYaml.load(raw));
}

interface SeedResult {
  profileId: string;
  campaignId: string;
  characterId: string;
  created: boolean;
}

/**
 * Ensure the Bebop profile exists (upsert by slug) and the user has a
 * playable Bebop campaign. Safe to call repeatedly — re-running won't
 * create duplicate campaigns or reset an in-flight campaign's state.
 */
export async function seedBebopCampaign(userId: string): Promise<SeedResult> {
  const bebop = loadBebopProfile();
  const db = getFirebaseFirestore();

  // 1. Upsert profile by slug. Using the slug as the doc id makes this
  // race-free: two concurrent first-deploy calls both write to the same
  // doc and last-writer-wins on identical content. The previous query
  // → add() pattern would have created duplicate profiles under storm
  // load. `serverTimestamp` for createdAt only fires on the first write
  // because subsequent set merges don't overwrite an already-present
  // timestamp; the version field stays 1 for the same reason.
  const profileId = BEBOP_PROFILE_SLUG;
  await db.collection(COL.profiles).doc(profileId).set(
    {
      slug: BEBOP_PROFILE_SLUG,
      title: bebop.title,
      mediaType: bebop.media_type,
      content: bebop,
      version: 1,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // 2. Settings — M1.5 multi-provider config + Bebop opening world state.
  const providerConfig = anthropicFallbackConfig();
  const settings = {
    provider: providerConfig.provider,
    tier_models: providerConfig.tier_models,
    active_dna: bebop.canonical_dna,
    active_composition: bebop.canonical_composition,
    world_state: {
      location: "The Bebop, docked in Ganymede drift traffic",
      situation:
        "Spike's waking up. The bounty board on the screen is blinking. Faye and Jet are arguing about something trivially important.",
      time_context: "Morning-ish. Station time means nothing out here.",
      arc_phase: "setup",
      tension_level: 0.2,
      present_npcs: ["Jet Black", "Faye Valentine", "Ein"],
    },
    overrides: [] as unknown[],
  };

  // 3. Check existing campaign: (ownerUid, name) where deletedAt is null.
  // Firestore can't combine "==" and "==null" plus "!=null" in arbitrary
  // ways, but a simple where-chain on equality holds.
  const campaignsCol = db.collection(COL.campaigns);
  const existingCampaignSnap = await campaignsCol
    .where("ownerUid", "==", userId)
    .where("name", "==", BEBOP_CAMPAIGN_NAME)
    .where("deletedAt", "==", null)
    .limit(1)
    .get();

  if (!existingCampaignSnap.empty) {
    const campDoc = existingCampaignSnap.docs[0];
    if (!campDoc) throw new Error("campaign snapshot empty after non-empty check");
    const charactersCol = campDoc.ref.collection(CAMPAIGN_SUB.characters);
    const charsSnap = await charactersCol.limit(1).get();
    if (!charsSnap.empty) {
      const charDoc = charsSnap.docs[0];
      if (!charDoc) throw new Error("character snapshot empty after non-empty check");
      return { profileId, campaignId: campDoc.id, characterId: charDoc.id, created: false };
    }
    // Campaign exists but no character — recover by creating one.
    const charRef = await charactersCol.add({
      campaignId: campDoc.id,
      name: SPIKE_CHARACTER.name,
      concept: SPIKE_CHARACTER.concept,
      powerTier: SPIKE_CHARACTER.power_tier,
      sheet: SPIKE_CHARACTER.sheet,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { profileId, campaignId: campDoc.id, characterId: charRef.id, created: false };
  }

  // 4. Create campaign + character.
  const campaignRef = await campaignsCol.add({
    ownerUid: userId,
    name: BEBOP_CAMPAIGN_NAME,
    phase: "playing",
    profileRefs: [BEBOP_PROFILE_SLUG],
    settings,
    createdAt: FieldValue.serverTimestamp(),
    deletedAt: null,
  });
  const characterRef = await campaignRef.collection(CAMPAIGN_SUB.characters).add({
    campaignId: campaignRef.id,
    name: SPIKE_CHARACTER.name,
    concept: SPIKE_CHARACTER.concept,
    powerTier: SPIKE_CHARACTER.power_tier,
    sheet: SPIKE_CHARACTER.sheet,
    createdAt: FieldValue.serverTimestamp(),
  });

  return {
    profileId,
    campaignId: campaignRef.id,
    characterId: characterRef.id,
    created: true,
  };
}
