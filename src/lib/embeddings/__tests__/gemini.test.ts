import type { GoogleGenAI } from "@google/genai";
import { describe, expect, it } from "vitest";
import { embedTextGemini } from "../gemini";

function mockGoogle(
  response: { embeddings?: Array<{ values?: number[] }> } | { error: Error },
): () => Pick<GoogleGenAI, "models"> {
  return () =>
    ({
      models: {
        async embedContent(_params: unknown) {
          if ("error" in response) throw response.error;
          return response;
        },
      },
    }) as unknown as Pick<GoogleGenAI, "models">;
}

describe("embedTextGemini", () => {
  it("returns a vector with dimension matching the SDK response", async () => {
    const google = mockGoogle({ embeddings: [{ values: [0.1, 0.2, 0.3] }] });
    const result = await embedTextGemini("hello world", { google });
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.dimension).toBe(3);
    expect(result.model).toBe("text-embedding-004");
    // tokens now char-length / 4 approximation; cost_usd derived from
    // pricing table for text-embedding-004 ($0.0125 per 1M input).
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.cost_usd).toBeGreaterThanOrEqual(0);
  });

  it("honors a model override", async () => {
    let seenModel: string | undefined;
    const google = (() =>
      ({
        models: {
          async embedContent(params: { model: string }) {
            seenModel = params.model;
            return { embeddings: [{ values: [0.5] }] };
          },
        },
      }) as unknown as Pick<GoogleGenAI, "models">) as unknown as () => Pick<GoogleGenAI, "models">;
    await embedTextGemini("x", { google, model: "text-embedding-002" });
    expect(seenModel).toBe("text-embedding-002");
  });

  it("rejects empty input", async () => {
    const google = mockGoogle({ embeddings: [{ values: [1] }] });
    await expect(embedTextGemini("   ", { google })).rejects.toThrow(/empty/);
  });

  it("throws when the SDK returns no embedding", async () => {
    const google = mockGoogle({ embeddings: [] });
    await expect(embedTextGemini("text", { google })).rejects.toThrow(/no embedding/i);
  });

  it("propagates SDK errors", async () => {
    const google = mockGoogle({ error: new Error("rate limited") });
    await expect(embedTextGemini("text", { google })).rejects.toThrow(/rate limited/);
  });
});
