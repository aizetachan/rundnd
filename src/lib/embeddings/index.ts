import { env } from "@/lib/env";
import { embedTextGemini } from "./gemini";
import type { EmbedResult } from "./types";

/**
 * Embedding dispatcher. Selects the backend per
 * `env.AIDM_EMBEDDING_PROVIDER`. M4 sub 1 ships `"gemini"` only;
 * the registry shape exists so Voyage / OpenAI can plug in later
 * without touching callers (per `docs/plans/M4-vector-search.md` §1.1).
 *
 * When provider is `"none"`, callers should NOT invoke `embedText` —
 * they're expected to check `isEmbedderConfigured()` and persist
 * `embedding: null` instead. This split keeps the failure shape
 * explicit (intentional null vs. runtime error).
 */

export type EmbeddingProvider = "gemini" | "none";

export interface EmbedTextOptions {
  /** Override the model id (defaults to the env's
   *  `AIDM_EMBEDDING_MODEL`). */
  model?: string;
}

export function isEmbedderConfigured(): boolean {
  return env.AIDM_EMBEDDING_PROVIDER !== "none";
}

export async function embedText(
  text: string,
  options: EmbedTextOptions = {},
): Promise<EmbedResult> {
  const provider = env.AIDM_EMBEDDING_PROVIDER;
  const model = options.model ?? env.AIDM_EMBEDDING_MODEL;
  if (provider === "none") {
    throw new Error(
      "embedText: AIDM_EMBEDDING_PROVIDER=none — caller must check isEmbedderConfigured() first.",
    );
  }
  if (provider === "gemini") {
    return embedTextGemini(text, { model });
  }
  throw new Error(`embedText: unknown provider "${provider satisfies never}"`);
}

export * from "./types";
export { embedTextGemini } from "./gemini";
