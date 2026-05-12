import { type RenderBlocksInput, renderKaBlocks } from "@/lib/ka/blocks";
import { getOpenAI } from "@/lib/llm";
import { getPrompt } from "@/lib/prompts";
import type { CampaignProviderConfig } from "@/lib/providers";
import type { AidmToolContext } from "@/lib/tools";
import type OpenAI from "openai";
import type { AgentDeps } from "../types";
import { defaultLogger } from "../types";

/**
 * OpenAI-KA — GPT 5.4 KeyAnimator backend (M5.5 narration-only).
 *
 * Mirror of Google-KA's sub 1: streams text deltas, renders the same
 * blocks 1-4 system prompt, yields the same `KeyAnimatorEvent` shape
 * Anthropic-KA does. No tool/Function Calling at sub 1 — that lands
 * in a future sub when telemetry from real GPT turns justifies the
 * tool-loop orchestration.
 *
 * Doubles as the OpenRouter shim — `runKeyAnimatorOpenAI` is
 * substrate-agnostic; OpenRouter just uses a different base URL +
 * API key on its own client surface.
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

export interface KeyAnimatorOpenAIInput extends RenderBlocksInput {
  modelContext: CampaignProviderConfig;
  toolContext: AidmToolContext;
  abortController?: AbortController;
}

export interface KeyAnimatorOpenAIDeps extends AgentDeps {
  /** Inject a mock OpenAI client in tests. */
  openai?: () => Pick<OpenAI, "chat">;
}

/** GPT-5.4 pricing snapshot from `src/lib/llm/pricing.ts`. */
const GPT_54_USD_PER_MTOK_INPUT = 10;
const GPT_54_USD_PER_MTOK_OUTPUT = 30;

function estimateGptCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * GPT_54_USD_PER_MTOK_INPUT + outputTokens * GPT_54_USD_PER_MTOK_OUTPUT) /
    1_000_000
  );
}

export async function* runKeyAnimatorOpenAI(
  input: KeyAnimatorOpenAIInput,
  deps: KeyAnimatorOpenAIDeps = {},
): AsyncGenerator<KeyAnimatorEvent, void, void> {
  const logger = deps.logger ?? defaultLogger;

  if (input.modelContext.provider !== "openai" && input.modelContext.provider !== "openrouter") {
    throw new Error(
      `runKeyAnimatorOpenAI invoked with provider="${input.modelContext.provider}" — dispatch bug`,
    );
  }
  const creativeModel = input.modelContext.tier_models.creative;
  const openai = (deps.openai ?? getOpenAI)();

  // Fingerprint recording — same shape as Anthropic-KA / Google-KA.
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
        /* non-fatal */
      }
    }
  }

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
    name: "agent:key-animator-openai",
    input: {
      player_message: userMessage,
      intent: input.block4.intent,
    },
    metadata: {
      model: creativeModel,
      provider: input.modelContext.provider,
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
    // Chat Completions API streaming. OpenAI's stream object is an
    // async iterator over delta chunks. We pull `choices[0].delta.content`
    // and `choices[0].finish_reason` per chunk; usage lands on the
    // final chunk when `stream_options.include_usage` is set.
    const stream = await openai.chat.completions.create({
      model: creativeModel,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userMessage },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        if (ttftMs === null) ttftMs = Date.now() - start;
        narrative += delta;
        yield { kind: "text", delta };
      }
      if (choice?.finish_reason) stopReason = String(choice.finish_reason);
      const usage = chunk.usage;
      if (usage) {
        inputTokens = usage.prompt_tokens ?? inputTokens;
        outputTokens = usage.completion_tokens ?? outputTokens;
      }
    }

    const totalMs = Date.now() - start;
    const costUsd = estimateGptCost(inputTokens, outputTokens);

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
    logger("info", "key-animator-openai: ok", {
      ...deps.logContext,
      model: creativeModel,
      provider: input.modelContext.provider,
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
      sessionId: null,
      stopReason,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger("error", "key-animator-openai: failed", {
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
