import { createMockQueryFn } from "@/lib/llm/mock/testing";
import { type CampaignProviderConfig, anthropicFallbackConfig } from "@/lib/providers";
import type { AidmToolContext } from "@/lib/tools";
import { describe, expect, it } from "vitest";
import { type SessionZeroConductorInput, runSessionZeroConductor } from "../session-zero-conductor";

/**
 * Conductor unit tests. Real Agent SDK + MCP wiring are exercised when
 * sub 3 lands the SSE endpoint — at that point integration covers the
 * tool-call path against Firestore. Here we cover:
 *   - Provider guard (anthropic-only at M2)
 *   - Thinking-tier model from modelContext threads through the SDK call
 *   - Streaming text deltas yield as text events; final event closes the run
 *   - userMessage encodes conversation history + new player message
 *   - prompt fingerprint is recorded on the audit trail
 */

const toolContext = {
  campaignId: "c-1",
  userId: "u-1",
} as unknown as AidmToolContext;

function baseInput(modelContext: CampaignProviderConfig): SessionZeroConductorInput {
  return {
    playerMessage: "I want a Cowboy Bebop campaign — Spike-replaced.",
    conversationHistory: [],
    modelContext,
    toolContext,
  };
}

describe("runSessionZeroConductor — provider guard + wiring", () => {
  it("throws when modelContext.provider is 'google'", async () => {
    const google: CampaignProviderConfig = {
      provider: "google",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gemini-3.1-flash-lite-preview",
        thinking: "gemini-3.1-pro-preview",
        creative: "gemini-3.1-pro-preview",
      },
    };
    const iter = runSessionZeroConductor(baseInput(google));
    await expect(iter.next()).rejects.toThrow(/google/i);
  });

  it("throws when modelContext.provider is 'openai'", async () => {
    const openai: CampaignProviderConfig = {
      provider: "openai",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gpt-5.4",
        thinking: "gpt-5.4",
        creative: "gpt-5.4",
      },
    };
    const iter = runSessionZeroConductor(baseInput(openai));
    await expect(iter.next()).rejects.toThrow(/openai/i);
  });

  it("threads thinking-tier model from modelContext into the SDK query", async () => {
    let seenModel: string | undefined;
    const queryFn = createMockQueryFn([
      {
        onCall: (args) => {
          seenModel = (args.options as { model?: string }).model;
        },
        chunks: ["ok"],
      },
    ]);
    const events: string[] = [];
    for await (const ev of runSessionZeroConductor(baseInput(anthropicFallbackConfig()), {
      queryFn,
    })) {
      events.push(ev.kind);
    }
    expect(seenModel).toBeDefined();
    expect(events).toContain("text");
    expect(events).toContain("final");
  });

  it("emits text deltas as text events; closes with final containing aggregate text", async () => {
    const queryFn = createMockQueryFn([
      {
        chunks: ["Hi! ", "Welcome to Session Zero."],
      },
    ]);
    const texts: string[] = [];
    let finalText: string | undefined;
    for await (const ev of runSessionZeroConductor(baseInput(anthropicFallbackConfig()), {
      queryFn,
    })) {
      if (ev.kind === "text") texts.push(ev.delta);
      if (ev.kind === "final") finalText = ev.text;
    }
    expect(texts).toEqual(["Hi! ", "Welcome to Session Zero."]);
    expect(finalText).toBe("Hi! Welcome to Session Zero.");
  });

  it("user message includes the player's new message + history scaffolding", async () => {
    let capturedPrompt: string | undefined;
    const queryFn = createMockQueryFn([
      {
        onCall: (args) => {
          capturedPrompt = args.prompt;
        },
        chunks: [""],
      },
    ]);
    const input: SessionZeroConductorInput = {
      ...baseInput(anthropicFallbackConfig()),
      playerMessage: "Make me a bounty hunter.",
      conversationHistory: [
        {
          role: "user",
          text: "Cowboy Bebop please",
          tool_calls: [],
          createdAt: new Date(),
        },
        {
          role: "conductor",
          text: "",
          tool_calls: [
            {
              name: "commit_field",
              args: { field: "profile_refs", value: ["cowboy_bebop"] },
              result: { committed: true },
            },
          ],
          createdAt: new Date(),
        },
      ],
    };
    for await (const _ of runSessionZeroConductor(input, { queryFn })) {
      /* drain */
    }
    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).toContain("Make me a bounty hunter.");
    expect(capturedPrompt).toContain("[user]");
    expect(capturedPrompt).toContain("[conductor]");
    expect(capturedPrompt).toContain("commit_field");
  });

  it("records the conductor prompt fingerprint when recordPrompt is provided", async () => {
    const fingerprints: Array<{ name: string; fp: string }> = [];
    const queryFn = createMockQueryFn([{ chunks: [""] }]);
    for await (const _ of runSessionZeroConductor(baseInput(anthropicFallbackConfig()), {
      queryFn,
      recordPrompt: (name, fp) => fingerprints.push({ name, fp }),
    })) {
      /* drain */
    }
    expect(fingerprints).toEqual([expect.objectContaining({ name: "session-zero-conductor" })]);
  });
});
