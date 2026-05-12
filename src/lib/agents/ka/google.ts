import { type RenderBlocksInput, renderKaBlocks } from "@/lib/ka/blocks";
import { getGoogle } from "@/lib/llm";
import { getPrompt } from "@/lib/prompts";
import type { CampaignProviderConfig } from "@/lib/providers";
import type { AidmToolContext } from "@/lib/tools";
import type { Content, FunctionCall, GoogleGenAI } from "@google/genai";
import type { AgentDeps } from "../types";
import { defaultLogger } from "../types";
import {
  buildGoogleKaConsultantDeclarations,
  executeConsultantCall,
  isConsultantCall,
} from "./google-consultants";
import { buildGoogleKaFunctionDeclarations, executeFunctionCall } from "./google-tools";

/**
 * Google-KA — Gemini 3.1 Pro KeyAnimator backend.
 *
 * Sub 1 (narration-only) shipped 2026-05-11.
 * Sub 2 wires the mid-turn tool surface: AIDM tool registry becomes
 * Function Declarations Gemini can call. The loop runs synchronous
 * non-streaming generateContent rounds while function calls fire,
 * then one final streaming round for the player-facing narrative.
 *
 * Consultants (OutcomeJudge, Validator, etc.) are still skipped at
 * sub 2 — they need their own Gemini-side orchestration (each
 * consultant becomes its own callable function that hits Sonnet 4.6
 * internally). Documented gap; doesn't block player turns.
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

  // Mid-turn tool loop. Each round either:
  //   (a) returns function calls → execute + append responses → next round.
  //   (b) returns text and no calls → break out of the loop, run a final
  //       streaming round on the same `contents` so the player sees the
  //       narrative stream in.
  // Round cap of 8 protects against runaway loops; Anthropic's Agent SDK
  // has its own internal cap.
  // Combine MCP tool declarations with consultant adapter declarations
  // (M3.5 sub 3). Both surfaces ride on the same Function Calling pipe;
  // the dispatcher routes consultant names through their _runner-based
  // executor (which dispatches back to Gemini for thinking-tier on a
  // Google campaign, closing the loop) and tool names through the
  // existing tool registry executor.
  const functionDeclarations = [
    ...buildGoogleKaFunctionDeclarations(),
    ...buildGoogleKaConsultantDeclarations(),
  ];
  const contents: Content[] = [{ role: "user", parts: [{ text: userMessage }] }];
  const MAX_ROUNDS = 8;

  try {
    let toolRoundsDone = false;
    for (let round = 0; round < MAX_ROUNDS && !toolRoundsDone; round++) {
      const response = await google.models.generateContent({
        model: creativeModel,
        contents,
        config: {
          systemInstruction,
          tools: functionDeclarations.length ? [{ functionDeclarations }] : undefined,
        },
      });
      const usage = response.usageMetadata;
      if (usage) {
        inputTokens = usage.promptTokenCount ?? inputTokens;
        outputTokens = usage.candidatesTokenCount ?? outputTokens;
      }
      const calls: FunctionCall[] = response.functionCalls ?? [];
      if (calls.length === 0) {
        // No tool calls — break out and run the streaming finalizer.
        toolRoundsDone = true;
        break;
      }
      // Append the model's tool-call message + every executed response
      // to `contents` so the next round sees the full state.
      contents.push({
        role: "model",
        parts: calls.map((c) => ({ functionCall: c })),
      });
      const responseParts = await Promise.all(
        calls.map(async (c) => {
          const callName = c.name ?? "";
          const result = isConsultantCall(callName)
            ? await executeConsultantCall(callName, c.args, input.modelContext)
            : await executeFunctionCall(callName, c.args, input.toolContext);
          return {
            functionResponse: {
              name: callName,
              response: result,
            },
          };
        }),
      );
      contents.push({ role: "user", parts: responseParts });
    }

    // Finalizer — stream the player-facing narrative now that any tool
    // rounds have populated `contents` with retrieved context. Disable
    // the tools surface so the model commits to text.
    const stream = await google.models.generateContentStream({
      model: creativeModel,
      contents,
      config: { systemInstruction },
    });

    for await (const chunk of stream) {
      const delta = chunk.text ?? "";
      if (delta) {
        if (ttftMs === null) ttftMs = Date.now() - start;
        narrative += delta;
        yield { kind: "text", delta };
      }
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
