import { getGoogle } from "@/lib/llm";
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
  return {
    vector: values,
    dimension: values.length,
    model,
    // SDK doesn't surface token count on the embed response — leave null.
    tokens: null,
  };
}

export { GEMINI_TEXT_EMBEDDING_004_DIM };
