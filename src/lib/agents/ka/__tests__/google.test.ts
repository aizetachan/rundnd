import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CampaignProviderConfig } from "@/lib/providers";
import type { AidmToolContext } from "@/lib/tools";
import { Profile } from "@/lib/types/profile";
import type { IntentOutput } from "@/lib/types/turn";
import type { GoogleGenAI } from "@google/genai";
import jsYaml from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * Tests for Google-KA. Mirrors `src/lib/agents/__tests__/key-animator.test.ts`
 * style — Bebop profile fixture as a stand-in for a real campaign.
 *
 * The Gemini SDK surface we mock: `models.generateContentStream(params)`
 * returns an async iterator of chunks; each chunk has `.text`,
 * optional `.usageMetadata.promptTokenCount/candidatesTokenCount`, and
 * optional `.candidates[0].finishReason` on the final chunk.
 */

function loadBebop(): Profile {
  const raw = readFileSync(
    join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml"),
    "utf8",
  );
  return Profile.parse(jsYaml.load(raw));
}

const intent: IntentOutput = {
  intent: "DEFAULT",
  action: "look around",
  target: "",
  epicness: 0.2,
  special_conditions: [],
  confidence: 0.9,
};

const toolContext = {
  campaignId: "c-1",
  userId: "u-1",
  db: {} as never,
} as unknown as AidmToolContext;

function googleContext(): CampaignProviderConfig {
  return {
    provider: "google",
    tier_models: {
      probe: "claude-haiku-4-5-20251001",
      fast: "gemini-3.1-flash-lite-preview",
      thinking: "gemini-3.1-pro-preview",
      creative: "gemini-3.1-pro-preview",
    },
  };
}

function baseInput(provider: "google" | "anthropic" = "google") {
  const modelContext = { ...googleContext(), provider } as CampaignProviderConfig;
  return {
    profile: loadBebop(),
    campaign: {},
    workingMemory: [],
    compaction: [],
    block4: {
      player_message: "Spike walks into the bar.",
      intent,
      player_overrides: [],
    },
    modelContext,
    toolContext,
  };
}

interface MockChunk {
  text?: string;
  usage?: { input: number; output: number };
  finishReason?: string;
}

function streamingGoogle(chunks: MockChunk[]): () => Pick<GoogleGenAI, "models"> {
  return () =>
    ({
      models: {
        // Sub 2 added a synchronous generateContent for the tool-call
        // loop. Tests that don't exercise tool calls expect this to
        // return "no functionCalls" so the loop breaks immediately.
        async generateContent(_params: unknown) {
          return {
            text: "",
            functionCalls: [],
            usageMetadata: undefined,
            candidates: undefined,
          };
        },
        async generateContentStream(_params: unknown) {
          async function* gen() {
            for (const c of chunks) {
              yield {
                text: c.text,
                usageMetadata: c.usage
                  ? {
                      promptTokenCount: c.usage.input,
                      candidatesTokenCount: c.usage.output,
                    }
                  : undefined,
                candidates: c.finishReason ? [{ finishReason: c.finishReason }] : undefined,
              };
            }
          }
          return gen();
        },
      },
    }) as unknown as Pick<GoogleGenAI, "models">;
}

describe("runKeyAnimatorGoogle", () => {
  it("streams text deltas + yields a final event with totals", async () => {
    const { runKeyAnimatorGoogle } = await import("../google");
    const google = streamingGoogle([
      { text: "Smoke drifted from the doorway. " },
      {
        text: "Spike paused, then pushed inside.",
        usage: { input: 1200, output: 240 },
        finishReason: "STOP",
      },
    ]);
    const events: Awaited<ReturnType<typeof runKeyAnimatorGoogle>> extends AsyncGenerator<
      infer E,
      void,
      void
    >
      ? E[]
      : never = [];
    for await (const ev of runKeyAnimatorGoogle(
      baseInput("google") as Parameters<typeof runKeyAnimatorGoogle>[0],
      { google },
    )) {
      events.push(ev);
    }
    const textEvents = events.filter((e) => e.kind === "text");
    const final = events.find((e) => e.kind === "final");
    expect(textEvents).toHaveLength(2);
    expect(final).toBeDefined();
    if (final && final.kind === "final") {
      expect(final.narrative).toBe(
        "Smoke drifted from the doorway. Spike paused, then pushed inside.",
      );
      expect(final.stopReason).toBe("STOP");
      expect(final.costUsd).toBeGreaterThan(0);
      expect(final.ttftMs).not.toBeNull();
    }
  });

  it("throws if invoked with a non-google provider (dispatch bug)", async () => {
    const { runKeyAnimatorGoogle } = await import("../google");
    const iter = runKeyAnimatorGoogle(
      baseInput("anthropic") as Parameters<typeof runKeyAnimatorGoogle>[0],
    );
    await expect(iter.next()).rejects.toThrow(/dispatch bug/);
  });

  it("propagates errors from the stream", async () => {
    const { runKeyAnimatorGoogle } = await import("../google");
    const google: () => Pick<GoogleGenAI, "models"> = () =>
      ({
        models: {
          async generateContent() {
            return { text: "", functionCalls: [] };
          },
          async generateContentStream() {
            throw new Error("upstream rate limit");
          },
        },
      }) as unknown as Pick<GoogleGenAI, "models">;
    const iter = runKeyAnimatorGoogle(
      baseInput("google") as Parameters<typeof runKeyAnimatorGoogle>[0],
      { google },
    );
    await expect(iter.next()).rejects.toThrow(/upstream rate limit/);
  });

  it("executes function calls then streams the finalizer (M3.5 sub 2)", async () => {
    const { runKeyAnimatorGoogle } = await import("../google");
    let toolRoundsSeen = 0;
    const google: () => Pick<GoogleGenAI, "models"> = () =>
      ({
        models: {
          async generateContent(_params: unknown) {
            toolRoundsSeen += 1;
            if (toolRoundsSeen === 1) {
              // First round: emit a tool call to a known KA tool.
              return {
                text: "",
                functionCalls: [{ name: "get_voice_patterns", args: {} }],
                usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 30 },
              };
            }
            // Second round: no more tool calls — let the streaming
            // finalizer take over.
            return { text: "", functionCalls: [] };
          },
          async generateContentStream(_params: unknown) {
            async function* gen() {
              yield {
                text: "Spike walked in.",
                usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 4 },
                candidates: [{ finishReason: "STOP" }],
              };
            }
            return gen();
          },
        },
      }) as unknown as Pick<GoogleGenAI, "models">;
    const events: Awaited<ReturnType<typeof runKeyAnimatorGoogle>> extends AsyncGenerator<
      infer E,
      void,
      void
    >
      ? E[]
      : never = [];
    for await (const ev of runKeyAnimatorGoogle(
      baseInput("google") as Parameters<typeof runKeyAnimatorGoogle>[0],
      { google },
    )) {
      events.push(ev);
    }
    expect(toolRoundsSeen).toBe(2);
    const final = events.find((e) => e.kind === "final");
    expect(final).toBeDefined();
    if (final && final.kind === "final") {
      expect(final.narrative).toBe("Spike walked in.");
    }
  });
});
