/**
 * Profile research surface — the path between "player names an IP" and
 * "Profile gets written to Firestore and indexed in Algolia." Wave B
 * of M2.
 *
 * Two paths (per ROADMAP §10.2), gated behind AIDM_PROFILE_RESEARCH_PATH:
 *   - Path A: AniList GraphQL (titles + franchise graph) + Fandom wiki
 *     (prose) → LLM structured-output parse.
 *   - Path B: Claude Opus 4.7 + extended thinking + native web_search
 *     tool → direct structured output.
 *
 * Both paths emit `AnimeResearchOutput`; `normalize.ts` converts that
 * into a full `Profile`. The split keeps the LLM's responsibility
 * narrow (produce facts, not canonical records).
 *
 * The eval harness at `evals/profile-generation/` runs both paths over
 * ground-truth YAMLs to drive the §10.6 decision rule.
 */

export * from "./types";
