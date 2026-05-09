/**
 * Barrel — every Firestore-typed schema lives here for clean imports.
 *
 * Sub-commits 5+ add schemas for the remaining entities (turns, npcs,
 * locations, etc.) as the corresponding modules get migrated. The plan
 * is one-schema-per-entity and one-file-per-entity to keep diffs scoped.
 */

export * from "./campaign";
export * from "./character";
export * from "./profile";
export * from "./user";
