import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyAnimatorEvent, KeyAnimatorInput } from "@/lib/agents/key-animator";
import { createMockAnthropic } from "@/lib/llm/mock/testing";
import type { CampaignProviderConfig } from "@/lib/providers";
import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { runTurn } from "../turn";

/**
 * End-to-end threading test for M1.5 modelContext (FU-A / FU-1).
 *
 * Per-commit unit tests prove:
 *   - `resolveModelContext` parses settings correctly (turn-gates.test.ts).
 *   - `runKeyAnimator` honors modelContext when it receives one (key-animator.test.ts).
 *   - `runStructuredAgent` dispatches by provider (_runner.test.ts).
 *
 * What they don't prove: the GLUE in `runTurn` itself actually reads
 * modelContext from the campaign doc and threads it into the `runKa`
 * call. If a future refactor drops `modelContext` from that invocation,
 * every unit test above still passes — but production quietly narrates
 * the campaign on Anthropic defaults instead of the configured model.
 *
 * This test closes that gap. Minimal Firestore fake + stub
 * IntentClassifier + mock runKa that captures the `modelContext` it
 * receives.
 */

function loadBebopProfileContent(): unknown {
  const raw = readFileSync(
    join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml"),
    "utf8",
  );
  // Round-trip through YAML → JSON via js-yaml that's already bundled.
  // Inline-require to avoid adding an import for one call site.
  const jsYaml = require("js-yaml") as { load: (s: string) => unknown };
  return jsYaml.load(raw);
}

function makeFs(opts: {
  campaignSettings: Record<string, unknown>;
  profileContent: unknown;
  onTurnAdd: (data: Record<string, unknown>) => { id: string };
}): Firestore {
  // Chainable empty-query stub for any subcollection query path. Every
  // method returns the same object; every `.get()` resolves empty.
  const emptySnap = async () => ({ empty: true, docs: [] });
  const emptyQuery: Record<string, unknown> = {};
  emptyQuery.where = () => emptyQuery;
  emptyQuery.orderBy = () => emptyQuery;
  emptyQuery.limit = () => emptyQuery;
  emptyQuery.get = emptySnap;
  emptyQuery.add = async (data: Record<string, unknown>) => opts.onTurnAdd(data);
  const subcolEmpty = emptyQuery;
  const campaignDocRef = {
    get: async () => ({
      exists: true,
      data: () => ({
        ownerUid: "u-1",
        deletedAt: null,
        name: "Bebop — test",
        phase: "playing",
        profileRefs: ["cowboy-bebop"],
        settings: opts.campaignSettings,
      }),
    }),
    set: async (_patch: Record<string, unknown>) => {
      /* swallow for test */
    },
    collection: (_name: string) => subcolEmpty,
  };
  const profilesCol = {
    where: () => ({
      limit: () => ({
        get: async () => ({
          empty: false,
          docs: [
            {
              id: "p-1",
              data: () => ({
                slug: "cowboy-bebop",
                title: "Cowboy Bebop",
                mediaType: "anime",
                content: opts.profileContent,
                version: 1,
                createdAt: new Date(),
              }),
            },
          ],
        }),
      }),
    }),
  };
  return {
    collection: (name: string) => {
      if (name === "campaigns") return { doc: () => campaignDocRef };
      if (name === "profiles") return profilesCol;
      if (name === "ruleLibraryChunks") return emptyQuery;
      throw new Error(`unexpected collection ${name}`);
    },
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const tx = {
        get: async (ref: unknown) => {
          if (ref === campaignDocRef) return campaignDocRef.get();
          throw new Error("unexpected tx.get");
        },
        set: () => {
          /* lock claim — swallow */
        },
      };
      return fn(tx);
    },
  } as unknown as Firestore;
}

// Unified mock Anthropic stub via Phase E helper.
function fakeAnthropic(text: string) {
  return createMockAnthropic([{ text }, { text }]);
}

describe("runTurn — modelContext threading (FU-A)", () => {
  it("passes the campaign's tier_models into runKa untouched", async () => {
    // Custom non-default config: pin creative to Sonnet 4.6 + thinking
    // to an Opus 4.5 snapshot. If turn.ts's glue drops modelContext,
    // runKa would see anthropicFallbackConfig() (all Opus 4.7) and the
    // assertion below would fail.
    const customContext: CampaignProviderConfig = {
      provider: "anthropic",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-4-5-20251101",
        creative: "claude-sonnet-4-6",
      },
    };

    const bebopContent = loadBebopProfileContent();

    // Capture what runKa received.
    let capturedInput: KeyAnimatorInput | undefined;
    const mockRunKa = async function* (
      input: KeyAnimatorInput,
    ): AsyncGenerator<KeyAnimatorEvent, void, void> {
      capturedInput = input;
      yield {
        kind: "final",
        narrative: "Spike stares at the ceiling.",
        ttftMs: 100,
        totalMs: 200,
        costUsd: 0.01,
        sessionId: "s-1",
        stopReason: "end_turn",
      };
    };

    const firestore = makeFs({
      campaignSettings: {
        provider: customContext.provider,
        tier_models: customContext.tier_models,
        active_dna: {},
        world_state: {
          location: "The Bebop",
          situation: "drifting",
          present_npcs: ["Jet"],
        },
      },
      profileContent: bebopContent,
      onTurnAdd: () => ({ id: "t-new" }),
    });

    // IntentClassifier routes via Anthropic by default (modelContext
    // passed through router → classifyIntent). Fake an Anthropic
    // response that returns a continue-branch intent so we reach KA.
    const intentClassifierAnthropic = fakeAnthropic(
      JSON.stringify({
        intent: "DEFAULT",
        action: "look around",
        epicness: 0.2, // low enough to skip OJ (shouldPreJudgeOutcome returns false)
        special_conditions: [],
        confidence: 0.9,
      }),
    );

    // Drain the generator. We don't care about the yielded events here;
    // we care about what runKa received.
    const events: unknown[] = [];
    for await (const ev of runTurn(
      { campaignId: "c-test", userId: "u-1", playerMessage: "look around" },
      {
        firestore,
        runKa: mockRunKa as never,
        routerDeps: { intentClassifier: { anthropic: intentClassifierAnthropic } },
      },
    )) {
      events.push(ev);
      if ((ev as { type: string }).type === "done" || (ev as { type: string }).type === "error") {
        break;
      }
    }

    expect(capturedInput).toBeDefined();
    expect(capturedInput?.modelContext).toEqual(customContext);
    // Specific assertion on the creative pin so a regression that partially
    // dropped fields (kept provider, dropped tier_models) fails loudly.
    expect(capturedInput?.modelContext.tier_models.creative).toBe("claude-sonnet-4-6");
    expect(capturedInput?.modelContext.tier_models.thinking).toBe("claude-opus-4-5-20251101");
  });

  it("records prompt fingerprints for every agent invoked during the turn (Commit 7.0)", async () => {
    // Run a minimal turn and capture the persisted values that turn.ts
    // wrote to the `turns` collection. promptFingerprints should be a
    // populated map — at minimum the IntentClassifier's fingerprint —
    // not the legacy `{}` sentinel.
    let insertedValues: Record<string, unknown> | undefined;
    const firestore = makeFs({
      campaignSettings: { active_dna: {}, world_state: { location: "here" } },
      profileContent: loadBebopProfileContent(),
      onTurnAdd: (values) => {
        insertedValues = values;
        return { id: "t-fp-new" };
      },
    });

    const mockRunKa = async function* (
      _input: KeyAnimatorInput,
    ): AsyncGenerator<KeyAnimatorEvent, void, void> {
      yield {
        kind: "final",
        narrative: "A beat happens.",
        ttftMs: 50,
        totalMs: 100,
        costUsd: 0.005,
        sessionId: "s-fp",
        stopReason: "end_turn",
      };
    };

    const intentClassifierAnthropic = fakeAnthropic(
      JSON.stringify({
        intent: "DEFAULT",
        epicness: 0.1, // below all pre-judge thresholds
        special_conditions: [],
        confidence: 0.9,
      }),
    );

    for await (const ev of runTurn(
      { campaignId: "c-fp", userId: "u-1", playerMessage: "sit" },
      {
        firestore,
        runKa: mockRunKa as never,
        routerDeps: { intentClassifier: { anthropic: intentClassifierAnthropic } },
      },
    )) {
      if ((ev as { type: string }).type === "done" || (ev as { type: string }).type === "error") {
        break;
      }
    }

    const fingerprints = insertedValues?.promptFingerprints as Record<string, string> | undefined;
    expect(fingerprints).toBeDefined();
    // IntentClassifier ran (router's pre-pass) → its fingerprint should
    // be captured. Value is a 64-char sha256 hex.
    expect(fingerprints?.["intent-classifier"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
