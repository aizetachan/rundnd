import { PROBE_DEFAULT, type ProviderDefinition } from "./types";

/**
 * OpenRouter provider — M5.5 thin shim over OpenAI-KA shipped
 * 2026-05-12.
 *
 * OpenRouter is the escape hatch: any model not in the Big 3's bounded
 * rosters is reachable through OpenRouter's OpenAI-compatible HTTP
 * surface. `allowFreeFormModels: true` — users type an exact OpenRouter
 * model ID; bad IDs surface as runtime errors from OpenRouter, not as
 * validation blocks at save time.
 */

export const openrouter: ProviderDefinition = {
  id: "openrouter",
  displayName: "OpenRouter",
  available: true,
  tiers: {
    probe: {
      defaultModel: PROBE_DEFAULT,
      selectableModels: [PROBE_DEFAULT],
    },
    // Reasonable defaults so a new OpenRouter campaign has working
    // tier_models out of the box. Users override per-tier.
    fast: { defaultModel: "deepseek/deepseek-chat", selectableModels: [] },
    thinking: { defaultModel: "anthropic/claude-sonnet-4.6", selectableModels: [] },
    creative: { defaultModel: "anthropic/claude-opus-4.7", selectableModels: [] },
  },
  features: {
    nativeMCP: false,
    promptCaching: "none",
    thinking: "none",
  },
  allowFreeFormModels: true,
};
