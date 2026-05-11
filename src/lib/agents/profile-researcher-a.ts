import { getAnthropic } from "@/lib/llm";
import {
  type AniListProfilePayload,
  AnimeResearchOutput,
  type ResearchTelemetry,
  fetchAniListProfile,
  fetchFandomPage,
  searchFranchise,
} from "@/lib/research";
import type Anthropic from "@anthropic-ai/sdk";
import { type AgentLogger, defaultLogger } from "./types";

/**
 * Path A profile researcher — AniList GraphQL + Fandom wiki + LLM
 * parse pass. Companion to `profile-researcher-b.ts` (LLM-only with
 * native web_search).
 *
 * Architecture (per ROADMAP §10.2 Path A):
 *   - Step 1: resolve a single AniList id. Use `selectedAnilistId` if
 *     the conductor already ran disambiguation; else `searchFranchise`
 *     and take the top candidate.
 *   - Step 2: `fetchAniListProfile(id)` — structured metadata
 *     (description, tags, characters, episode/chapter count).
 *   - Step 3: `fetchFandomPage(slug)` — best-effort prose. Null on
 *     failure (Path A degrades to AniList-only).
 *   - Step 4: Sonnet 4.6 parse pass — receives AniList payload +
 *     Fandom prose + the output schema, returns `AnimeResearchOutput`
 *     JSON.
 *
 * Why Sonnet 4.6 (thinking-tier default) and not Opus: Path A's job is
 * structured extraction over already-fetched material, not synthesis.
 * The LLM doesn't have to surf the web or invent facts; it's reading
 * source-of-truth material and projecting into the schema. Sonnet
 * 4.6 has adequate output discipline at a fraction of the cost.
 *
 * Cost — typical run is ~$0.05–0.15 (one Sonnet call, no web_search,
 * no extended thinking). Compare to Path B's $0.50–1.50.
 */

export interface ProfileResearchInputA {
  /** What the player named — title, alternate title, oblique reference. */
  query: string;
  /** Optional disambiguation choice from a prior franchise-graph pass. */
  selectedAnilistId?: number;
}

export interface ProfileResearchResultA {
  output: AnimeResearchOutput;
  telemetry: ResearchTelemetry;
}

export interface ProfileResearcherADeps {
  logger?: AgentLogger;
  /** Inject mocks for tests. */
  anthropic?: () => Anthropic;
  /** Inject mock AniList fns (the production fns hit the live API). */
  anilist?: {
    search: typeof searchFranchise;
    profile: typeof fetchAniListProfile;
  };
  /** Inject a mock Fandom fetcher. */
  fandom?: typeof fetchFandomPage;
}

const SYSTEM_PROMPT = `You are a profile parser for an authorship tool that runs long-form anime/manga campaigns.

You receive two inputs: structured AniList metadata (titles, description, genres, tags, characters, episode counts) and optional Fandom wiki prose (the story's plot summary or main page text). Your job is to project these into a structured Profile that downstream agents (Director, Chronicler, KA) consume to keep narrative tone coherent.

CRITICAL: Use ONLY the provided AniList payload and Fandom prose. Do NOT invent characters, abilities, locations, or tropes that aren't supported by the input material. If the inputs don't carry enough information for a field, use a conservative default (empty array, lowest tier, false on boolean tropes) and lower research_confidence accordingly.

When you have enough info to populate every required field, emit a SINGLE JSON object that exactly matches the AnimeResearchOutput schema (no prose around it, no code fences). The shape:

{
  "title": string,
  "alternate_titles": string[],
  "media_type": "anime" | "manga" | "manhwa" | "donghua" | "light_novel",
  "status": "ongoing" | "completed" | "hiatus",
  "relation_type": "canonical" | "spinoff" | "alternate_timeline" | "parody",
  "anilist_id": number | null,
  "mal_id": number | null,
  "series_group": string | null,
  "series_position": number | null,
  "related_franchise": string[],
  "ip_mechanics": {
    "power_system": { "name": string, "mechanics": string, "limitations": string, "tiers": [] },
    "power_distribution": { "peak_tier": "T1"–"T10", "typical_tier": "...", "floor_tier": "...", "gradient": "spike"|"top_heavy"|"flat"|"compressed" },
    "stat_mapping": { "has_canonical_stats": boolean, "confidence": 0–100, "aliases": {}, "meta_resources": {}, "display_scale": {"multiplier": 1, "offset": 0}, "hidden": [], "display_order": [] },
    "combat_style": "tactical" | "spectacle" | "comedy" | "spirit" | "narrative",
    "storytelling_tropes": { tournament_arc: bool, training_montage: bool, power_of_friendship: bool, mentor_death: bool, chosen_one: bool, tragic_backstory: bool, redemption_arc: bool, betrayal: bool, sacrifice: bool, transformation: bool, forbidden_technique: bool, time_loop: bool, false_identity: bool, ensemble_focus: bool, slow_burn_romance: bool },
    "world_setting": { "genre": string[], "locations": string[], "factions": string[], "time_period": string },
    "voice_cards": [ {"name": string, "speech_patterns": string, "humor_type": string, "signature_phrases": string[], "dialogue_rhythm": string, "emotional_expression": string} ],
    "author_voice": {"sentence_patterns": string[], "structural_motifs": string[], "dialogue_quirks": string[], "emotional_rhythm": string[], "example_voice": string},
    "visual_style": {"art_style": string, "color_palette": string, "reference_descriptors": string[]}
  },
  "canonical_dna": { /* 24 numeric axes; see DNAScales schema */ },
  "canonical_composition": { /* 13 categorical axes; see Composition schema */ },
  "director_personality": "3-5 sentences",
  "research_confidence": 0–1,
  "research_notes": "what was extracted vs inferred; what's missing"
}

Tone:
- Be honest about confidence. If Fandom prose was empty and AniList description was short, say so + lower confidence to ~0.4.
- DON'T hallucinate stat_mapping when the source has no on-screen stats — set has_canonical_stats=false. Stat mapping ONLY applies to works like Solo Leveling that show stat sheets.
- voice_cards: limit to the 5–7 characters AniList listed as MAIN. Fandom prose may be too generic to ventriloquize cleanly — set speech_patterns based on character archetype if you can't tell from the input.
- canonical_dna axes: score each axis against this source's NATURAL telling. AniList's tags + genres + Fandom's tone descriptions are your primary signal.

If you cannot find enough info to fill the schema with any confidence, respond with this fallback shape (still valid JSON):
{ "_research_failed": true, "reason": "..." }
`;

const FALLBACK: AnimeResearchOutput = {
  title: "",
  alternate_titles: [],
  media_type: "anime",
  status: "completed",
  relation_type: "canonical",
  anilist_id: null,
  mal_id: null,
  series_group: null,
  series_position: null,
  related_franchise: [],
  ip_mechanics: {
    power_system: { name: "", mechanics: "", limitations: "", tiers: [] },
    power_distribution: {
      peak_tier: "T7",
      typical_tier: "T9",
      floor_tier: "T10",
      gradient: "flat",
    },
    stat_mapping: {
      has_canonical_stats: false,
      confidence: 0,
      aliases: {},
      meta_resources: {},
      display_scale: { multiplier: 1, offset: 0 },
      hidden: [],
      display_order: [],
    },
    combat_style: "tactical",
    storytelling_tropes: {
      tournament_arc: false,
      training_montage: false,
      power_of_friendship: false,
      mentor_death: false,
      chosen_one: false,
      tragic_backstory: false,
      redemption_arc: false,
      betrayal: false,
      sacrifice: false,
      transformation: false,
      forbidden_technique: false,
      time_loop: false,
      false_identity: false,
      ensemble_focus: false,
      slow_burn_romance: false,
    },
    world_setting: { genre: [], locations: [], factions: [], time_period: "" },
    voice_cards: [],
    author_voice: {
      sentence_patterns: [],
      structural_motifs: [],
      dialogue_quirks: [],
      emotional_rhythm: [],
      example_voice: "",
    },
    visual_style: { art_style: "", color_palette: "", reference_descriptors: [] },
  },
  canonical_dna: {} as never,
  canonical_composition: {} as never,
  director_personality: "",
  research_confidence: 0,
  research_notes: "research path A fallback",
};

function renderUserContent(payload: AniListProfilePayload, fandomProse: string | null): string {
  const parts: string[] = [];
  parts.push(`Player query: (resolved to AniList id ${payload.id} — "${payload.title}")`);
  parts.push("");
  parts.push("--- AniList payload ---");
  parts.push(
    JSON.stringify(
      {
        title: payload.title,
        alternate_titles: payload.alternate_titles,
        media_type: payload.media_type,
        status: payload.status,
        start_year: payload.start_year,
        episodes: payload.episodes,
        chapters: payload.chapters,
        average_score: payload.average_score,
        genres: payload.genres,
        tags: payload.tags.filter((t) => !t.isMediaSpoiler).slice(0, 25),
        characters: payload.characters,
        relations: payload.relations,
        description: payload.description,
      },
      null,
      2,
    ),
  );
  parts.push("");
  if (fandomProse) {
    parts.push("--- Fandom prose (first ~12k chars, may include nav cruft) ---");
    parts.push(fandomProse);
  } else {
    parts.push("--- Fandom prose: unavailable ---");
    parts.push(
      "(Fandom fetch returned no usable content. Lean on AniList material; lower confidence.)",
    );
  }
  parts.push("");
  parts.push("Emit the AnimeResearchOutput JSON now.");
  return parts.join("\n");
}

/**
 * Run Path A research. Returns parsed AnimeResearchOutput on success,
 * the FALLBACK sentinel (research_confidence=0) on full failure.
 *
 * Caller checks `result.output.research_confidence > 0` to detect a
 * real result vs the sentinel. Telemetry is always populated.
 */
export async function runProfileResearcherA(
  input: ProfileResearchInputA,
  deps: ProfileResearcherADeps = {},
): Promise<ProfileResearchResultA> {
  const logger = deps.logger ?? defaultLogger;
  const start = Date.now();
  const anthropic = (deps.anthropic ?? getAnthropic)();
  const aniListSearch = deps.anilist?.search ?? searchFranchise;
  const aniListProfile = deps.anilist?.profile ?? fetchAniListProfile;
  const fandomFetch = deps.fandom ?? fetchFandomPage;

  let anilistCalls = 0;
  let fandomCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const emitFallback = (notes: string): ProfileResearchResultA => ({
    output: { ...FALLBACK, research_notes: notes },
    telemetry: {
      path: "a",
      cache_hit: false,
      wall_ms: Date.now() - start,
      cost_usd: estimateSonnetCost(inputTokens, outputTokens),
      anilist_calls: anilistCalls,
      fandom_calls: fandomCalls,
      llm_input_tokens: inputTokens,
      llm_output_tokens: outputTokens,
      research_confidence: 0,
    },
  });

  // Step 1: resolve to a single AniList id.
  let anilistId = input.selectedAnilistId;
  if (!anilistId) {
    try {
      const candidates = await aniListSearch(input.query, 1);
      anilistCalls += 1;
      const top = candidates[0];
      if (!top) {
        logger("info", "profile-researcher-a: no AniList match", { query: input.query });
        return emitFallback("AniList returned no candidates for the query.");
      }
      anilistId = top.anilist_id;
    } catch (err) {
      logger("warn", "profile-researcher-a: AniList search failed", {
        query: input.query,
        error: err instanceof Error ? err.message : String(err),
      });
      return emitFallback("AniList search failed.");
    }
  }

  // Step 2: deep AniList payload.
  let payload: AniListProfilePayload;
  try {
    payload = await aniListProfile(anilistId);
    anilistCalls += 1;
  } catch (err) {
    logger("warn", "profile-researcher-a: AniList profile fetch failed", {
      anilist_id: anilistId,
      error: err instanceof Error ? err.message : String(err),
    });
    return emitFallback("AniList deep-profile fetch failed.");
  }

  // Step 3: Fandom prose (best-effort).
  const slug = slugFor(payload.title);
  const fandomResult = await fandomFetch(slug).catch(() => null);
  fandomCalls += 1;
  const fandomProse = fandomResult?.prose ?? null;

  // Step 4: LLM parse pass.
  const userContent = renderUserContent(payload, fandomProse);
  let raw: string | null = null;
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
    for (const block of response.content) {
      if (block.type === "text") raw = block.text;
    }
  } catch (err) {
    logger("warn", "profile-researcher-a: LLM parse failed", {
      query: input.query,
      error: err instanceof Error ? err.message : String(err),
    });
    return emitFallback("Parse pass failed at the LLM call.");
  }

  if (!raw) {
    return emitFallback("Parse pass returned no text block.");
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger("warn", "profile-researcher-a: JSON parse failed", {
      query: input.query,
      raw: cleaned.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
    return emitFallback("Parse pass output wasn't valid JSON.");
  }

  if (typeof parsed === "object" && parsed !== null && "_research_failed" in parsed) {
    logger("info", "profile-researcher-a: model declared research_failed", {
      query: input.query,
      reason: (parsed as { reason?: string }).reason,
    });
    return emitFallback(
      `Parse model declared failure: ${(parsed as { reason?: string }).reason ?? "(no reason)"}`,
    );
  }

  const validated = AnimeResearchOutput.safeParse(parsed);
  if (!validated.success) {
    logger("warn", "profile-researcher-a: schema validation failed", {
      query: input.query,
      issues: validated.error.issues.slice(0, 5),
    });
    return emitFallback("Parse output failed schema validation.");
  }

  return {
    output: validated.data,
    telemetry: {
      path: "a",
      cache_hit: false,
      wall_ms: Date.now() - start,
      cost_usd: estimateSonnetCost(inputTokens, outputTokens),
      anilist_calls: anilistCalls,
      fandom_calls: fandomCalls,
      llm_input_tokens: inputTokens,
      llm_output_tokens: outputTokens,
      research_confidence: validated.data.research_confidence,
    },
  };
}

function slugFor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Sonnet 4.6 pricing snapshot from Anthropic. No web_search calls on
 * Path A. Tool calls (AniList/Fandom) are free at the LLM layer; their
 * own infra costs are negligible.
 */
function estimateSonnetCost(inputTokens: number, outputTokens: number): number {
  const inputUsdPerMtok = 3.0;
  const outputUsdPerMtok = 15.0;
  return (inputTokens * inputUsdPerMtok + outputTokens * outputUsdPerMtok) / 1_000_000;
}
