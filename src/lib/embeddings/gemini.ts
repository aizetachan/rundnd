import { getGoogle } from "@/lib/llm";
import { estimateCostUsd } from "@/lib/llm/pricing";
import type { GoogleGenAI } from "@google/genai";
import { type EmbedResult, GEMINI_TEXT_EMBEDDING_004_DIM } from "./types";

/**
 * Gemini text-embedding-004 backend. 768-dim, $0.0125 per 1M input
 * tokens. The default embedder for M4 (per `docs/plans/M4-vector-search.md`
 * §1.1) — picked over Voyage/OpenAI because the @google/genai SDK is
 * already a runtime dependency and the cost is sub-cent per typical
 * semantic memory fact.
 */

const DEFAULT_GEMINI_EMBEDDING_MODEL = "text-embedding-004";

export interface GeminiEmbedDeps {
  /** Inject a mock Google client in tests. */
  google?: () => Pick<GoogleGenAI, "models">;
  /** Override the model id; defaults to text-embedding-004. */
  model?: string;
}

/**
 * Embed a single text string. Returns `EmbedResult` with the vector,
 * dimension, model name, and (when available) the token count.
 *
 * Throws on API error — callers (e.g. `write_semantic_memory`) catch
 * and log, then persist with `embedding: null` so writes don't block
 * on embedder availability.
 */
export async function embedTextGemini(
  text: string,
  deps: GeminiEmbedDeps = {},
): Promise<EmbedResult> {
  if (!text.trim()) {
    throw new Error("embedTextGemini: input text is empty");
  }
  const client = (deps.google ?? getGoogle)();
  const model = deps.model ?? DEFAULT_GEMINI_EMBEDDING_MODEL;
  const response = await client.models.embedContent({
    model,
    contents: text,
  });
  const values = response.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error(`embedTextGemini: model ${model} returned no embedding for the given text`);
  }
  // Gemini's embed response doesn't surface a token count. Approximate
  // input tokens from char-length (≈4 chars/token, conservative for
  // English). The cost ledger uses this only as an upper-bound estimate;
  // a future SDK version that returns token counts would supersede.
  const approxTokens = Math.ceil(text.length / 4);
  const cost = estimateCostUsd(model, {
    input_tokens: approxTokens,
    output_tokens: 0,
  });
  return {
    vector: values,
    dimension: values.length,
    model,
    tokens: approxTokens,
    cost_usd: cost,
  };
}

export { GEMINI_TEXT_EMBEDDING_004_DIM };
