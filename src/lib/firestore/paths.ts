/**
 * Centralized collection paths for the Firestore data layer.
 *
 * Top-level collections are simple constants. Subcollections are exposed
 * as helper functions that take their parent ID(s) — encoding the
 * hierarchy in code is what gives us a single source of truth across
 * repos, security rules, and seed scripts.
 *
 * Hierarchy (M0.5 mapping decisions in docs/plans/M0.5-firebase-migration.md):
 *
 *   users/{uid}
 *     rateCounters/{minuteBucket}
 *     costLedger/{dayBucket}
 *
 *   profiles/{profileId}                     (top-level — shared across users)
 *
 *   ruleLibraryChunks/{chunkId}              (top-level — shared)
 *
 *   campaigns/{campaignId}                   (top-level; ownerUid for queries)
 *     characters/{characterId}
 *     turns/{turnId}
 *     contextBlocks/{blockId}
 *     npcs/{npcId}
 *     locations/{locationId}
 *     factions/{factionId}
 *     relationshipEvents/{eventId}
 *     semanticMemories/{memoryId}
 *     foreshadowingSeeds/{seedId}
 *     voicePatterns/{patternId}
 *     directorNotes/{noteId}
 *     spotlightDebt/{debtId}
 *     arcPlanHistory/{historyId}
 */

export const COL = {
  users: "users",
  profiles: "profiles",
  campaigns: "campaigns",
  ruleLibraryChunks: "ruleLibraryChunks",
} as const;

export const USER_SUB = {
  rateCounters: "rateCounters",
  costLedger: "costLedger",
} as const;

export const CAMPAIGN_SUB = {
  characters: "characters",
  turns: "turns",
  contextBlocks: "contextBlocks",
  npcs: "npcs",
  locations: "locations",
  factions: "factions",
  relationshipEvents: "relationshipEvents",
  semanticMemories: "semanticMemories",
  foreshadowingSeeds: "foreshadowingSeeds",
  voicePatterns: "voicePatterns",
  directorNotes: "directorNotes",
  spotlightDebt: "spotlightDebt",
  arcPlanHistory: "arcPlanHistory",
} as const;
