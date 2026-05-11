/**
 * Embedding surface — shared types for the M4 vector-search work.
 *
 * Sub 1 ships the write-path embedder; sub 2 wires the read path.
 * Both speak `Vector` + `EmbedResult`. Backends (Gemini today,
 * Voyage / OpenAI later) implement `EmbedFn`.
 */

/**
 * A single embedding — a fixed-length array of floats. We use a plain
 * number[] (not Float32Array) so Firestore's `VectorValue` serializer
 * accepts it without an explicit conversion, and so tests can compare
 * with regular array literals.
 */
export type Vector = number[];

export interface EmbedResult {
  vector: Vector;
  /** Dimensionality of the vector (matches `vector.length`). */
  dimension: number;
  /** Model identifier that produced the embedding. */
  model: string;
  /** Token count consumed for the embed call. Approx — providers
   *  report this differently; null when unavailable. */
  tokens: number | null;
  /** USD cost estimate for this single embed call, derived from the
   *  canonical pricing table. Zero when token count is unknown. */
  cost_usd: number;
}

export type EmbedFn = (text: string) => Promise<EmbedResult>;

export const GEMINI_TEXT_EMBEDDING_004_DIM = 768;
