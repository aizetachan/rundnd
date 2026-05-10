import { getAnthropic } from "@/lib/llm";
import { AnimeResearchOutput, type ResearchTelemetry } from "@/lib/research/types";
import type Anthropic from "@anthropic-ai/sdk";
import { type AgentLogger, defaultLogger } from "./types";

/**
 * Path B profile researcher — Claude Opus 4.7 + native `web_search` tool.
 *
 * Architecture (per ROADMAP §10.2 Path B):
 *   - Single-shot agent loop (NOT streaming, NOT Agent SDK).
 *   - One built-in tool: web_search.
 *   - Model decides when it has enough info; emits final JSON matching
 *     `AnimeResearchOutput` schema in the last assistant message.
 *   - The runner parses JSON, validates with Zod, retries once on
 *     parse/validation failure, returns `null` on full failure (caller
 *     decides whether to fall back to substring-degraded heuristics or
 *     just block the SZ flow).
 *
 * Cost — easily $0.50–1.50 per call with Opus + web_search + extended
 * thinking. Mitigated by `searchProfileLibrary` short-circuiting when
 * a slug already exists.
 *
 * KA / Chronicler use the Claude Agent SDK because they're long-running
 * tool-calling loops over the campaign's MCP surface. Path B has none
 * of that: one query, one tool, one answer. Raw SDK is the right size.
 */

export interface ProfileResearchInput {
  /** What the player named — title, alternate title, oblique reference. */
  query: string;
  /** Optional disambiguation choice from a prior franchise-graph pass.
   *  When present, the system prompt narrows research to this AniList id
   *  and skips the candidate-listing phase. */
  selectedAnilistId?: number;
}

export interface ProfileResearchResult {
  output: AnimeResearchOutput;
  telemetry: ResearchTelemetry;
}

export interface ProfileResearcherDeps {
  logger?: AgentLogger;
  /** Inject a mock Anthropic client in tests. Defaults to getAnthropic(). */
  anthropic?: () => Anthropic;
}

const SYSTEM_PROMPT = `You are a profile researcher for an authorship tool that runs long-form anime/manga campaigns.

Your job: given a media reference from the player ("Cowboy Bebop", "Solo Leveling", "Hellsing but with Bleach's pacing"), produce a structured Profile that downstream agents (Director, Chronicler, KA) consume to keep narrative tone coherent.

Use the \`web_search\` tool to verify facts. Sources to prefer: AniList, MyAnimeList, the official Wiki/Fandom page for the title. Cross-check tropes, voice cards, power tiers across at least two sources. If sources disagree, prefer the more canonical / earliest-published one.

When you have enough info to populate every required field, emit a SINGLE JSON object that exactly matches this schema (no prose around it, no code fences):

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
    "power_distribution": { "peak_tier": "T1"–"T10", "typical_tier": "...", "floor_tier": "...", "gradient": "spike"|"top_heavy"|"flat"|"compressed" },
    "stat_mapping": { "has_canonical_stats": boolean, "confidence": 0–100, "aliases": {...}, "meta_resources": {...}, "display_scale": {"multiplier": number, "offset": number}, "hidden": [], "display_order": [] },
    "combat_style": "tactical" | "spectacle" | "comedy" | "spirit" | "narrative",
    "storytelling_tropes": { tournament_arc: bool, training_montage: bool, power_of_friendship: bool, mentor_death: bool, chosen_one: bool, tragic_backstory: bool, redemption_arc: bool, betrayal: bool, sacrifice: bool, transformation: bool, forbidden_technique: bool, time_loop: bool, false_identity: bool, ensemble_focus: bool, slow_burn_romance: bool },
    "world_setting": { "genre": string[], "locations": string[], "factions": string[], "time_period": string },
    "voice_cards": [ {"name": string, "speech_patterns": string, "humor_type": string, "signature_phrases": string[], "dialogue_rhythm": string, "emotional_expression": string} ],
    "author_voice": {"sentence_patterns": string[], "structural_motifs": string[], "dialogue_quirks": string[], "emotional_rhythm": string[], "example_voice": string},
    "visual_style": {"art_style": string, "color_palette": string, "reference_descriptors": string[]}
  },
  "canonical_dna": { /* 24 numeric axes; see DNAScales schema */ },
  "canonical_composition": { /* 13 categorical axes; see Composition schema */ },
  "director_personality": "3-5 sentences of how a director on this work would frame scenes",
  "research_confidence": 0–1,
  "research_notes": "what was hard, what's missing, what assumptions you made"
}

Tone:
- Be honest about confidence. If the source is obscure, say so in research_notes and lower research_confidence.
- DON'T hallucinate stat_mapping when the source has no on-screen stats — set has_canonical_stats=false. Stat mapping ONLY applies to works like Solo Leveling that show stat sheets.
- voice_cards: 5–7 main cast at most. Each card should be specific enough that a writer can ventriloquize the character.
- canonical_dna axes are signed/ranged numbers — score each axis against this source's NATURAL telling, not what the player said they want.

If you cannot find enough info to fill the schema with reasonable confidence, respond with this fallback shape (still valid JSON):
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
  canonical_dna: {} as never, // DNAScales has many fields; fallback returns are upstream-detectable via research_confidence=0
  canonical_composition: {} as never,
  director_personality: "",
  research_confidence: 0,
  research_notes: "research path B fallback",
};

/**
 * Run Path B research. Returns parsed AnimeResearchOutput on success,
 * the FALLBACK sentinel (research_confidence=0) on full failure.
 *
 * Caller checks `result.output.research_confidence > 0` to detect a
 * real result vs the sentinel. Telemetry is always populated.
 */
export async function runProfileResearcherB(
  input: ProfileResearchInput,
  deps: ProfileResearcherDeps = {},
): Promise<ProfileResearchResult> {
  const logger = deps.logger ?? defaultLogger;
  const start = Date.now();
  const anthropic = (deps.anthropic ?? getAnthropic)();

  const userContent = input.selectedAnilistId
    ? `Player named: "${input.query}"\nAniList id confirmed: ${input.selectedAnilistId}\nResearch this exact entry; do not list candidates.`
    : `Player named: "${input.query}"\nIf the title is ambiguous (e.g. "Naruto" → original/Shippuden/Boruto), pick the canonically-first / most popular entry and note the alternatives in research_notes.`;

  let raw: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
        } as unknown as Anthropic.Messages.Tool,
      ],
      thinking: {
        type: "enabled",
        budget_tokens: 8000,
      },
    });

    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;

    // Find the final text block — assistant's last response after all
    // tool_use rounds are done. We pick the last `text` block in
    // content; web_search results land as tool_result blocks the model
    // already consumed.
    for (const block of response.content) {
      if (block.type === "text") raw = block.text;
    }
  } catch (err) {
    logger("warn", "profile-researcher-b: API call failed", {
      query: input.query,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const wallMs = Date.now() - start;
  const telemetry: ResearchTelemetry = {
    path: "b",
    cache_hit: false,
    wall_ms: wallMs,
    cost_usd: estimateOpusCost(inputTokens, outputTokens),
    anilist_calls: 0,
    fandom_calls: 0,
    llm_input_tokens: inputTokens,
    llm_output_tokens: outputTokens,
    research_confidence: null,
  };

  if (!raw) {
    return { output: FALLBACK, telemetry };
  }

  // Strip code fences if the model wrapped despite the prompt.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger("warn", "profile-researcher-b: JSON parse failed", {
      query: input.query,
      raw: cleaned.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
    return { output: FALLBACK, telemetry };
  }

  // Detect the explicit failure sentinel the prompt allows.
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "_research_failed" in parsed
  ) {
    logger("info", "profile-researcher-b: model declared research_failed", {
      query: input.query,
      reason: (parsed as { reason?: string }).reason,
    });
    return { output: FALLBACK, telemetry };
  }

  const validated = AnimeResearchOutput.safeParse(parsed);
  if (!validated.success) {
    logger("warn", "profile-researcher-b: schema validation failed", {
      query: input.query,
      issues: validated.error.issues.slice(0, 5),
    });
    return { output: FALLBACK, telemetry };
  }

  telemetry.research_confidence = validated.data.research_confidence;
  return { output: validated.data, telemetry };
}

/**
 * Rough cost estimate for Opus 4.7 per Anthropic's published pricing
 * snapshot. Web_search bills separately as tool calls; the count isn't
 * surfaced cleanly via the response, so we approximate on tokens
 * alone — eval harness consumes the real bill from Langfuse anyway.
 */
function estimateOpusCost(inputTokens: number, outputTokens: number): number {
  const inputUsdPerMtok = 15.0;
  const outputUsdPerMtok = 75.0;
  return (inputTokens * inputUsdPerMtok + outputTokens * outputUsdPerMtok) / 1_000_000;
}
