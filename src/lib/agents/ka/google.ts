import { type RenderBlocksInput, renderKaBlocks } from "@/lib/ka/blocks";
import { getGoogle } from "@/lib/llm";
import { getPrompt } from "@/lib/prompts";
import type { CampaignProviderConfig } from "@/lib/providers";
import type { AidmToolContext } from "@/lib/tools";
import type { GoogleGenAI } from "@google/genai";
import type { AgentDeps } from "../types";
import { defaultLogger } from "../types";

/**
 * Google-KA — Gemini 3.1 Pro KeyAnimator backend.
 *
 * Sub 1 scope (per `docs/plans/M3.5-google-ka.md`): narration-only.
 * Streams text deltas; renders the same blocks 1-4 system prompt;
 * yields the same `KeyAnimatorEvent` shape Anthropic-KA does. Does
 * NOT spawn consultants (OutcomeJudge, Validator, etc.) and does
 * NOT expose MCP tools — those land in sub 2 once we have telemetry
 * from real Gemini turns to decide which Function Declarations are
 * worth the orchestration cost.
 *
 * For sub 1, a Google-campaign turn means: KA narrates from the
 * rendered context; post-turn workers (memory writer, Chronicler)
 * still fire on the narrative. The mid-turn tool surface is the gap.
 */

const ANTHROPIC_BOUNDARY = "<|SYSTEM_PROMPT_DYNAMIC_BOUNDARY|>";

export interface KeyAnimatorYieldText {
  kind: "text";
  delta: string;
}
export interface KeyAnimatorYieldFinal {
  kind: "final";
  narrative: string;
  ttftMs: number | null;
  totalMs: number;
  costUsd: number | null;
  sessionId: string | null;
  stopReason: string | null;
}
export type KeyAnimatorEvent = KeyAnimatorYieldText | KeyAnimatorYieldFinal;

export interface KeyAnimatorGoogleInput extends RenderBlocksInput {
  modelContext: CampaignProviderConfig;
  toolContext: AidmToolContext;
  abortController?: AbortController;
}

export interface KeyAnimatorGoogleDeps extends AgentDeps {
  /** Inject a mock Google client in tests. */
  google?: () => Pick<GoogleGenAI, "models">;
}

/**
 * Pricing snapshot for Gemini 3.1 Pro per Google's published rates
 * (per 1M tokens). Update if the prices shift; we report the usage
 * cost on the final event so Langfuse + cost ledger see consistent
 * numbers across providers.
 */
const GEMINI_PRO_USD_PER_MTOK_INPUT = 1.25;
const GEMINI_PRO_USD_PER_MTOK_OUTPUT = 5.0;

function estimateGeminiProCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * GEMINI_PRO_USD_PER_MTOK_INPUT + outputTokens * GEMINI_PRO_USD_PER_MTOK_OUTPUT) /
    1_000_000
  );
}

/**
 * Run KA on Gemini for one turn. Mirrors Anthropic-KA's generator
 * contract: streams `{kind: "text", delta}` events as text flows in,
 * then a single `{kind: "final", ...}` event with totals.
 *
 * On stream / API failure, throws. The SSE handler upstream surfaces
 * a terminal error to the player (same shape Anthropic-KA failures
 * follow).
 */
export async function* runKeyAnimatorGoogle(
  input: KeyAnimatorGoogleInput,
  deps: KeyAnimatorGoogleDeps = {},
): AsyncGenerator<KeyAnimatorEvent, void, void> {
  const logger = deps.logger ?? defaultLogger;

  if (input.modelContext.provider !== "google") {
    throw new Error(
      `runKeyAnimatorGoogle invoked with provider="${input.modelContext.provider}" — dispatch bug`,
    );
  }
  const creativeModel = input.modelContext.tier_models.creative;
  const google = (deps.google ?? getGoogle)();

  // Fingerprint recording — Gemini-KA still rolls up the four block
  // fingerprints into the prompt audit trail so a voice regression is
  // traceable to the exact prompt commit, same as Anthropic-KA.
  if (deps.recordPrompt) {
    const blockIds = [
      "ka/block_1_ambient",
      "ka/block_2_compaction",
      "ka/block_3_working",
      "ka/block_4_dynamic",
    ] as const;
    for (const id of blockIds) {
      try {
        deps.recordPrompt(`key-animator:${id}`, getPrompt(id).fingerprint);
      } catch {
        /* prompt-registry lookup failure is non-fatal */
      }
    }
  }

  // Render blocks. Gemini's `cachedContent` API isn't wired at sub 1
  // (different cache model than Anthropic's breakpoints), so blocks
  // 1-3 + 4 are concatenated into a single systemInstruction with a
  // visible marker between cached + dynamic portions. The marker
  // helps the eval harness diff cached-vs-dynamic when comparing
  // Anthropic vs Google runs of the same turn.
  const blocks = renderKaBlocks(input);
  const systemInstruction = [
    blocks.block1,
    blocks.block2,
    blocks.block3,
    ANTHROPIC_BOUNDARY,
    blocks.block4,
  ].join("\n\n");
  const userMessage = input.block4.player_message;

  const span = deps.trace?.span({
    name: "agent:key-animator-google",
    input: {
      player_message: userMessage,
      intent: input.block4.intent,
    },
    metadata: {
      model: creativeModel,
      provider: "google",
      tier: "creative",
    },
  });

  const start = Date.now();
  let ttftMs: number | null = null;
  let narrative = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;

  try {
    // The SDK's streaming surface: generateContentStream returns an
    // async iterator over response chunks. Each chunk has `.text` (the
    // delta text) and optionally `.usageMetadata` on the final chunk.
    const stream = await google.models.generateContentStream({
      model: creativeModel,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction,
        // Gemini 3 Pro supports native thinking; budget-tokens model
        // is "auto" — Gemini decides based on prompt complexity. Sub 2
        // can pin a budget if cost telemetry surfaces a need.
      },
    });

    for await (const chunk of stream) {
      const delta = chunk.text ?? "";
      if (delta) {
        if (ttftMs === null) ttftMs = Date.now() - start;
        narrative += delta;
        yield { kind: "text", delta };
      }
      // usageMetadata appears on the final chunk in Gemini's streaming
      // shape. Capture token counts as they come; final estimate uses
      // the last seen value.
      const usage = chunk.usageMetadata;
      if (usage) {
        inputTokens = usage.promptTokenCount ?? inputTokens;
        outputTokens = usage.candidatesTokenCount ?? outputTokens;
      }
      const finishReason = chunk.candidates?.[0]?.finishReason;
      if (finishReason) stopReason = String(finishReason);
    }

    const totalMs = Date.now() - start;
    const costUsd = estimateGeminiProCost(inputTokens, outputTokens);

    span?.end({
      output: {
        narrative_length: narrative.length,
        ttft_ms: ttftMs,
        total_ms: totalMs,
        cost_usd: costUsd,
        stop_reason: stopReason,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    });
    logger("info", "key-animator-google: ok", {
      ...deps.logContext,
      model: creativeModel,
      provider: "google",
      ttftMs,
      totalMs,
      costUsd,
      stopReason,
      narrativeLength: narrative.length,
    });

    yield {
      kind: "final",
      narrative,
      ttftMs,
      totalMs,
      costUsd,
      // Gemini doesn't surface a session id the way Agent SDK does.
      // Null is correct — Langfuse / trace correlation rides on the
      // observability span id, not a session id from the provider.
      sessionId: null,
      stopReason,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger("error", "key-animator-google: failed", {
      ...deps.logContext,
      error: errMsg,
      ttftMs,
      partialNarrativeLength: narrative.length,
    });
    span?.end({
      metadata: {
        error: errMsg,
        ttft_ms: ttftMs,
        partial_narrative_length: narrative.length,
      },
    });
    throw err;
  }
}
