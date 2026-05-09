import { z } from "zod";

/**
 * `ruleLibraryChunks/{chunkId}` — top-level shared narration guidance,
 * keyed deterministically on (category, axis, value_key). Populated by
 * `pnpm rules:index` from `rule_library/**\/*.yaml` (script writes one
 * doc per entry; doc id is a sanitized concatenation of the lookup key
 * for idempotent upserts).
 *
 * `embedding` is reserved for M4; left as `unknown` so M0.5 can move
 * without committing to a vector shape.
 */
export const FirestoreRuleLibraryChunk = z.object({
  id: z.string(),
  /** Human-readable slug — e.g. "dna_heroism", "power_tier_T3". */
  librarySlug: z.string().optional(),
  /** Top-level grouping: dna | composition | power_tier | archetype | beat_craft | ... */
  category: z.string(),
  /** Subgrouping within the category — null for non-axis categories. */
  axis: z.string().nullable().optional(),
  /** The specific value being looked up — null for aggregate entries. */
  valueKey: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  retrieveConditions: z.record(z.string(), z.unknown()).default({}),
  /** Narration directive (1–5 sentences of prose). */
  content: z.string(),
  version: z.number().int().positive().default(1),
  embedding: z.unknown().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type FirestoreRuleLibraryChunk = z.infer<typeof FirestoreRuleLibraryChunk>;
