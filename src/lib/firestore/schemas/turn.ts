import { z } from "zod";

/**
 * `campaigns/{campaignId}/turns/{turnId}` — single exchange between
 * player and KA. Persisted end-to-end for audit, recall, and
 * cost/latency analysis.
 *
 * Note: `narrative_tsv` (Postgres tsvector for recall_scene full-text
 * search) is not modeled here — full-text search migrates to Algolia
 * in Fase 4 via the official Firebase extension.
 */
export const VerdictKind = z.enum(["continue", "meta", "override", "worldbuilder"]);
export type VerdictKind = z.infer<typeof VerdictKind>;

export const FirestoreTurn = z.object({
  id: z.string(),
  campaignId: z.string(),
  turnNumber: z.number().int().nonnegative(),
  playerMessage: z.string(),
  narrativeText: z.string().default(""),
  summary: z.string().nullable().optional(),
  intent: z.unknown().nullable().optional(),
  outcome: z.unknown().nullable().optional(),
  promptFingerprints: z.record(z.string(), z.unknown()).default({}),
  traceId: z.string().nullable().optional(),
  portraitMap: z.record(z.string(), z.unknown()).default({}),
  verdictKind: VerdictKind.default("continue"),
  costUsd: z.number().nullable().optional(),
  ttftMs: z.number().int().nullable().optional(),
  totalMs: z.number().int().nullable().optional(),
  chronicledAt: z.date().nullable().optional(),
  styleDriftUsed: z.string().nullable().optional(),
  flags: z.array(z.unknown()).default([]),
  createdAt: z.date(),
});
export type FirestoreTurn = z.infer<typeof FirestoreTurn>;
