import { resolveClaudeCodeBinary } from "@/lib/llm/claude-binary";
import { getQueryFn } from "@/lib/llm/mock/runtime";
import { getPrompt } from "@/lib/prompts";
import type { CampaignProviderConfig } from "@/lib/providers";
import { buildSessionZeroMcpServers } from "@/lib/tools";
import type { AidmToolContext } from "@/lib/tools";
import type { ConductorMessage } from "@/lib/types/session-zero";
import type { Options, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDeps } from "./types";
import { defaultLogger } from "./types";

/**
 * SessionZeroConductor — onboarding orchestrator (M2 Wave A).
 *
 * Runs on Claude Agent SDK against `tier_models.thinking` (Sonnet 4.6
 * by default, per the cost-down on 2026-04-23; campaigns may pin Opus).
 *
 * Architecture invariants the call-site relies on:
 *   - Anthropic-only at M2 (Claude Agent SDK substrate). Other providers
 *     throw — same provider-guard pattern as KA + Chronicler.
 *   - Per-turn context: re-primes from `conversation_history` every
 *     turn rather than carrying Mastra session state across requests.
 *     Cost mitigated by the Anthropic prompt-cache (system prompt +
 *     history is the cacheable prefix). Sub 3's SSE wiring keeps this
 *     re-prime cheap; if cost surfaces in M2 telemetry, revisit.
 */

export interface SessionZeroConductorInput {
  /** The player's message for this turn. */
  playerMessage: string;
  /**
   * The conductor's accumulated conversation_history with the player,
   * in chronological order. Re-primes the conductor each turn (no
   * cross-request session state in M2 first ship). Empty array on
   * the first turn.
   */
  conversationHistory: ConductorMessage[];
  /**
   * Per-campaign provider + tier_models. Conductor runs on the
   * thinking tier; sub 2 only uses Anthropic.
   */
  modelContext: CampaignProviderConfig;
  /**
   * Tool + MCP context. Threaded into buildSessionZeroMcpServers so
   * every tool authorizes against the right campaign + user.
   */
  toolContext: AidmToolContext;
  /** Abort controller for cancelling the turn mid-stream. */
  abortController?: AbortController;
}

export interface SessionZeroConductorYieldText {
  kind: "text";
  delta: string;
}

export interface SessionZeroConductorYieldFinal {
  kind: "final";
  /** Full text the conductor streamed this turn. */
  text: string;
  /** Count of MCP tool_use blocks observed. Proxy for "work done." */
  toolCallCount: number;
  /** ms from query start to first text_delta. */
  ttftMs: number | null;
  /** ms from query start to result message. */
  totalMs: number;
  /** Total cost in USD reported by Agent SDK. */
  costUsd: number | null;
  sessionId: string | null;
  stopReason: string | null;
}

export type SessionZeroConductorEvent =
  | SessionZeroConductorYieldText
  | SessionZeroConductorYieldFinal;

export interface SessionZeroConductorDeps extends AgentDeps {
  /** Inject a mock `query` function in tests. */
  queryFn?: typeof query;
}

const EFFORT_DEFAULT: Options["effort"] = "medium";

/**
 * Render conversation_history as a transcript prefix the conductor
 * receives BEFORE the new player message. We don't try to reconstruct
 * Anthropic's native multi-turn message format here — the conductor
 * runs as a single-shot query each turn against a transcript-rendered
 * user message, which keeps M2 first ship simple. Sub 3 may revisit
 * if continuity costs become a problem.
 */
function renderHistory(history: ConductorMessage[]): string {
  if (history.length === 0) return "(this is the first turn — no prior history)";
  const lines = history.map((m) => {
    const head = `[${m.role}]`;
    const body = m.text || "";
    if (m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls
        .map((c) => `  tool_call: ${c.name}(${JSON.stringify(c.args)})`)
        .join("\n");
      return [head, body, calls].filter(Boolean).join("\n");
    }
    return [head, body].filter(Boolean).join("\n");
  });
  return lines.join("\n\n");
}

function buildUserContent(input: SessionZeroConductorInput): string {
  return [
    "## Conversation so far",
    renderHistory(input.conversationHistory),
    "",
    "## Player's new message",
    input.playerMessage,
    "",
    "Advance Session Zero by one turn. Use tools when you commit, propose, ask, or finalize. End your text when the turn is done.",
  ].join("\n");
}

function textDeltaOf(msg: SDKMessage): string | null {
  if (msg.type !== "stream_event") return null;
  const ev = msg.event;
  if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
    return ev.delta.text;
  }
  return null;
}

function countToolUseBlocks(msg: SDKMessage): number {
  if (msg.type !== "assistant") return 0;
  const message = (msg as { message?: { content?: Array<{ type?: string }> } }).message;
  const content = message?.content ?? [];
  return content.filter((c) => c?.type === "tool_use").length;
}

export async function* runSessionZeroConductor(
  input: SessionZeroConductorInput,
  deps: SessionZeroConductorDeps = {},
): AsyncGenerator<SessionZeroConductorEvent, void, void> {
  const logger = deps.logger ?? defaultLogger;
  const queryFn = deps.queryFn ?? getQueryFn();

  if (input.modelContext.provider !== "anthropic") {
    throw new Error(
      `SessionZeroConductor on Claude Agent SDK only supports provider="anthropic" (got "${input.modelContext.provider}"). Other providers land alongside their native KA implementations (M3.5 / M5.5).`,
    );
  }
  const thinkingModel = input.modelContext.tier_models.thinking;

  if (deps.recordPrompt) {
    try {
      deps.recordPrompt(
        "session-zero-conductor",
        getPrompt("agents/session-zero-conductor").fingerprint,
      );
    } catch {
      /* prompt-registry lookup failure is non-fatal; turn still runs */
    }
  }

  const systemPrompt = getPrompt("agents/session-zero-conductor").content;
  const userMessage = buildUserContent(input);
  const mcpServers = buildSessionZeroMcpServers(input.toolContext);
  const abortController = input.abortController ?? new AbortController();

  // Mirror KA's options pattern (see key-animator.ts:281). Adaptive
  // thinking is load-bearing here: the conductor plans multi-turn
  // elicitation against a 5–15 turn budget, so the per-turn thinking
  // window matters more than for a one-shot consultant.
  const options: Options = {
    model: thinkingModel,
    systemPrompt,
    tools: [],
    mcpServers,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    persistSession: false,
    includePartialMessages: true,
    thinking: { type: "adaptive" },
    effort: EFFORT_DEFAULT,
    abortController,
    env: process.env,
    pathToClaudeCodeExecutable: resolveClaudeCodeBinary(),
  };

  const start = Date.now();
  let ttftMs: number | null = null;
  let text = "";
  let toolCallCount = 0;
  let sessionId: string | null = null;
  let stopReason: string | null = null;
  let costUsd: number | null = null;

  const span = deps.trace?.span({
    name: "agent:session-zero-conductor",
    input: {
      player_message: input.playerMessage,
      history_turns: input.conversationHistory.length,
    },
    metadata: {
      model: thinkingModel,
      provider: input.modelContext.provider,
      tier: "thinking",
    },
  });

  try {
    for await (const msg of queryFn({ prompt: userMessage, options })) {
      if (msg.type === "system" && "session_id" in msg) {
        sessionId = (msg as { session_id?: string }).session_id ?? sessionId;
      }
      toolCallCount += countToolUseBlocks(msg);
      const delta = textDeltaOf(msg);
      if (delta) {
        if (ttftMs === null) ttftMs = Date.now() - start;
        text += delta;
        yield { kind: "text", delta };
        continue;
      }
      if (msg.type === "result") {
        stopReason = msg.stop_reason;
        costUsd = msg.subtype === "success" ? msg.total_cost_usd : null;
        sessionId = msg.session_id ?? sessionId;
        if (msg.subtype !== "success") {
          const err = `SessionZeroConductor result error: ${msg.subtype}`;
          logger("error", err, { ...deps.logContext, sessionId, stopReason });
          throw new Error(err);
        }
      }
    }

    const totalMs = Date.now() - start;
    span?.end({
      output: {
        text_length: text.length,
        tool_call_count: toolCallCount,
        ttft_ms: ttftMs,
        total_ms: totalMs,
        cost_usd: costUsd,
        stop_reason: stopReason,
      },
    });
    logger("info", "session-zero-conductor: ok", {
      ...deps.logContext,
      sessionId,
      model: thinkingModel,
      provider: input.modelContext.provider,
      ttftMs,
      totalMs,
      costUsd,
      stopReason,
      textLength: text.length,
      toolCallCount,
      historyTurns: input.conversationHistory.length,
    });

    yield {
      kind: "final",
      text,
      toolCallCount,
      ttftMs,
      totalMs,
      costUsd,
      sessionId,
      stopReason,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger("error", "session-zero-conductor: failed", {
      ...deps.logContext,
      sessionId,
      error: errMsg,
      ttftMs,
      partialTextLength: text.length,
      toolCallsBeforeError: toolCallCount,
    });
    span?.end({
      metadata: {
        error: errMsg,
        ttft_ms: ttftMs,
        partial_text_length: text.length,
        tool_calls_before_error: toolCallCount,
      },
    });
    throw err;
  }
}
