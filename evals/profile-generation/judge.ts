/**
 * Gemini-as-judge soft scoring axes for profile-generation eval.
 *
 * Mechanical scorers (DNA delta, trope agreement, power-tier delta,
 * stat mapping) live in `score.ts`. Judge axes are different: they
 * grade qualitative dimensions where two outputs can be numerically
 * different but creatively equivalent.
 *
 * Two axes ship here per `docs/plans/M2-wave-b-sub-6-7.md` §2.2:
 *   - Voice-card quality: do the produced voice cards capture the
 *     character's distinct cadence / speech patterns / humor type
 *     well enough that a downstream KA can ventriloquize them?
 *   - Visual-style alignment: does the produced visual_style
 *     description match the source's actual look (art style, palette,
 *     framing) per the ground-truth fixture?
 *
 * Each axis runs Gemini 3.1 Pro as the judge against a rubric prompt
 * with a 1-5 scale. The §10.6 decision rule treats Path B as
 * sufficient when judge scores are within 0.3 of Path A.
 *
 * Judge calls are best-effort; on Gemini failure the score is null
 * and downstream aggregation excludes it.
 */
import { getGoogle } from "@/lib/llm";
import type { AnimeResearchOutput } from "@/lib/research";
import type { Profile } from "@/lib/types/profile";
import type { GoogleGenAI } from "@google/genai";

const JUDGE_MODEL = "gemini-3.1-pro-preview";

export interface JudgeScore {
  axis: "voice_cards" | "visual_style";
  /** 1-5 score, null on judge failure. */
  score: number | null;
  /** Brief rationale from the judge; null when score is null. */
  rationale: string | null;
}

export interface JudgeDeps {
  google?: () => Pick<GoogleGenAI, "models">;
}

const VOICE_RUBRIC = `You are evaluating how well an authorship tool extracted voice cards from a media source.

Score the PRODUCED voice cards against the GROUND-TRUTH voice cards on a 1-5 scale where:
- 5: Each main-cast character has a distinct, ventriloquizable voice (speech_patterns, humor_type, signature_phrases all specific enough that a writer could draft new dialogue in their voice without re-reading the show).
- 4: Most characters are well-captured; one or two read generic.
- 3: Voice cards are present but interchangeable — most characters could be swapped without losing meaning.
- 2: Voice cards exist but miss core character signatures (e.g. Spike's laconic deflection, Faye's switching registers).
- 1: Voice cards are absent, generic, or hallucinated outside the source.

Return JSON: {"score": 1-5 number, "rationale": "1-2 sentence explanation"}. No prose, no fences.`;

const VISUAL_RUBRIC = `You are evaluating how well an authorship tool described visual style from a media source.

Score the PRODUCED visual_style against the GROUND-TRUTH visual_style on a 1-5 scale where:
- 5: Art style, color palette, line work, atmosphere, and framing all align with the source's actual look (style descriptors, studio/director references).
- 4: Most dimensions correct; one or two are off (e.g. wrong era of anime, missing key palette).
- 3: General genre is right but specifics are generic (e.g. "anime style" instead of "Watanabe neon-noir").
- 2: Some descriptors contradict the source.
- 1: Description is wrong genre / hallucinated / absent.

Return JSON: {"score": 1-5 number, "rationale": "1-2 sentence explanation"}. No prose, no fences.`;

async function callJudge(
  google: () => Pick<GoogleGenAI, "models">,
  rubric: string,
  userContent: string,
): Promise<{ score: number | null; rationale: string | null }> {
  try {
    const client = google();
    const response = await client.models.generateContent({
      model: JUDGE_MODEL,
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      config: { systemInstruction: rubric, temperature: 0 },
    });
    const text = response.text?.trim();
    if (!text) return { score: null, rationale: null };
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as { score?: number; rationale?: string };
    if (typeof parsed.score !== "number" || parsed.score < 1 || parsed.score > 5) {
      return { score: null, rationale: null };
    }
    return {
      score: parsed.score,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : null,
    };
  } catch {
    return { score: null, rationale: null };
  }
}

export async function judgeVoiceCards(
  produced: AnimeResearchOutput["ip_mechanics"]["voice_cards"],
  groundTruth: Profile["ip_mechanics"]["voice_cards"],
  deps: JudgeDeps = {},
): Promise<JudgeScore> {
  const google = deps.google ?? getGoogle;
  const userContent = [
    "PRODUCED voice cards:",
    JSON.stringify(produced, null, 2),
    "",
    "GROUND-TRUTH voice cards:",
    JSON.stringify(groundTruth, null, 2),
    "",
    "Score now.",
  ].join("\n");
  const result = await callJudge(google, VOICE_RUBRIC, userContent);
  return { axis: "voice_cards", ...result };
}

export async function judgeVisualStyle(
  produced: AnimeResearchOutput["ip_mechanics"]["visual_style"],
  groundTruth: Profile["ip_mechanics"]["visual_style"],
  deps: JudgeDeps = {},
): Promise<JudgeScore> {
  const google = deps.google ?? getGoogle;
  const userContent = [
    "PRODUCED visual_style:",
    JSON.stringify(produced, null, 2),
    "",
    "GROUND-TRUTH visual_style:",
    JSON.stringify(groundTruth, null, 2),
    "",
    "Score now.",
  ].join("\n");
  const result = await callJudge(google, VISUAL_RUBRIC, userContent);
  return { axis: "visual_style", ...result };
}
