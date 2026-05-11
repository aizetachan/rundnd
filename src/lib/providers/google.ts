import { PROBE_DEFAULT, type ProviderDefinition } from "./types";

/**
 * Google provider — Google-KA shipped at M3.5 sub 1 (narration-only
 * Gemini-native KA loop). Tools + consultants on Gemini are sub 2.
 *
 * The roster is the user-confirmed 2026-04-19 list of valid Gemini IDs:
 *   - gemini-3.1-flash-lite-preview (cheapest flash; fast-tier fit)
 *   - gemini-3-flash-preview (standard flash; mid)
 *   - gemini-3.1-pro-preview (pro tier; thinking/creative fit)
 */

export const GOOGLE_ROSTER: readonly string[] = [
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
];

export const google: ProviderDefinition = {
  id: "google",
  displayName: "Google",
  available: true,
  tiers: {
    probe: {
      // Probe stays Haiku universally until revisited per-provider.
      // Kept here so the shape is consistent; not used while Google
      // is unavailable.
      defaultModel: PROBE_DEFAULT,
      selectableModels: [PROBE_DEFAULT],
    },
    fast: {
      defaultModel: "gemini-3.1-flash-lite-preview",
      selectableModels: GOOGLE_ROSTER,
    },
    thinking: {
      defaultModel: "gemini-3.1-pro-preview",
      selectableModels: GOOGLE_ROSTER,
    },
    creative: {
      defaultModel: "gemini-3.1-pro-preview",
      selectableModels: GOOGLE_ROSTER,
    },
  },
  features: {
    nativeMCP: false,
    promptCaching: "context-id",
    thinking: "native",
  },
};
