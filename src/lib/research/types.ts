import { Composition } from "@/lib/types/composition";
import { DNAScales } from "@/lib/types/dna";
import { IPMechanics, MediaStatus, MediaType, RelationType } from "@/lib/types/profile";
import { z } from "zod";

/**
 * Research output schema — what a profile-researcher subagent produces
 * regardless of path (A: scrapers + parse; B: LLM-only with web_search).
 *
 * Mirrors the v3 `AnimeResearchOutput` shape. Downstream
 * `src/lib/research/normalize.ts` converts this into a full Zod
 * `Profile` (the schema actually persisted in Firestore + consumed by
 * Director / Chronicler / KA).
 *
 * The two-step shape (research output → normalize → Profile) keeps the
 * researcher subagent's responsibility narrow: produce facts, not a
 * canonical record. Normalization adds defaults, fills slug, sets
 * version=1 — all deterministic, none of which the LLM should be
 * trusted to do.
 */
export const AnimeResearchOutput = z.object({
  // Identification (what the researcher must surface)
  title: z.string(),
  alternate_titles: z.array(z.string()).default([]),
  media_type: MediaType,
  status: MediaStatus,
  relation_type: RelationType.default("canonical"),

  // External IDs (Path A populates these from AniList; Path B may leave
  // them null — that's allowed). When null on the cache-hit path, the
  // search-by-slug semantics still work because slug is canonical.
  anilist_id: z.number().int().nullable().optional(),
  mal_id: z.number().int().nullable().optional(),
  series_group: z.string().nullable().optional(),
  series_position: z.number().int().nullable().optional(),
  related_franchise: z.array(z.string()).default([]),

  // The world (what the researcher gathers in detail)
  ip_mechanics: IPMechanics,

  // Tonal / framing — researcher's best read of the source's NATURAL voice
  canonical_dna: DNAScales,
  canonical_composition: Composition,

  // Director personality — IP-specific directing voice. ~3-5 sentences.
  director_personality: z.string(),

  // Self-assessment + telemetry the eval harness consumes
  research_confidence: z.number().min(0).max(1),
  research_notes: z.string().nullable().optional(),
});
export type AnimeResearchOutput = z.infer<typeof AnimeResearchOutput>;

/**
 * Research path — Path A (scrapers + parse) vs Path B (LLM-only with
 * web_search). The harness compares both; production picks one based
 * on the ROADMAP §10.6 decision rule.
 */
export const ResearchPath = z.enum(["a", "b"]);
export type ResearchPath = z.infer<typeof ResearchPath>;

/**
 * Telemetry from a single research call — the eval harness's input unit.
 * `cost_usd` is the actual Anthropic + AniList + Fandom spend; `wall_ms`
 * is start-to-finish; `cache_hit` distinguishes a profile-library
 * lookup short-circuit from a full research run.
 */
export const ResearchTelemetry = z.object({
  path: ResearchPath,
  cache_hit: z.boolean().default(false),
  wall_ms: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  anilist_calls: z.number().int().nonnegative().default(0),
  fandom_calls: z.number().int().nonnegative().default(0),
  llm_input_tokens: z.number().int().nonnegative().default(0),
  llm_output_tokens: z.number().int().nonnegative().default(0),
  research_confidence: z.number().min(0).max(1).nullable().optional(),
});
export type ResearchTelemetry = z.infer<typeof ResearchTelemetry>;

/**
 * Disambiguation candidate — when AniList franchise-graph returns
 * multiple distinct entries for the same title query, the conductor
 * surfaces this list to the player. Each candidate carries enough
 * info to be picked from a chat message ("Naruto" vs "Naruto Shippuden"
 * vs "Boruto"), without a second round-trip.
 */
export const FranchiseCandidate = z.object({
  anilist_id: z.number().int(),
  title: z.string(),
  alternate_titles: z.array(z.string()).default([]),
  media_type: MediaType,
  status: MediaStatus,
  relation_to_query: RelationType.default("canonical"),
  /** Coarse year for ordering in the UI ("Naruto 2002 vs Naruto Shippuden 2007"). */
  start_year: z.number().int().nullable().optional(),
  /** AniList popularity score — sort the candidates by this descending. */
  popularity: z.number().int().nullable().optional(),
  /** Short prose ("Original 2002 anime — 220 episodes, pre-Shippuden timeline"). */
  brief: z.string(),
});
export type FranchiseCandidate = z.infer<typeof FranchiseCandidate>;
