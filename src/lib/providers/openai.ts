import { PROBE_DEFAULT, type ProviderDefinition } from "./types";

/**
 * OpenAI provider — M5.5 narration-only OpenAI-KA shipped 2026-05-12.
 *
 * Roster pinned to GPT-5.4 (creative + thinking) and GPT-5 mini for
 * fast tier. The user can extend selectable models as OpenAI publishes
 * more.
 *
 * OpenAI-KA doubles as the OpenRouter shim — same HTTP surface, different
 * base URL — see `src/lib/agents/ka/openai.ts` + `src/lib/agents/ka/openrouter.ts`.
 */

export const OPENAI_ROSTER: readonly string[] = ["gpt-5.4", "gpt-5-mini"];

export const openai: ProviderDefinition = {
  id: "openai",
  displayName: "OpenAI",
  available: true,
  tiers: {
    probe: {
      defaultModel: PROBE_DEFAULT,
      selectableModels: [PROBE_DEFAULT],
    },
    fast: { defaultModel: "gpt-5-mini", selectableModels: OPENAI_ROSTER },
    thinking: { defaultModel: "gpt-5.4", selectableModels: OPENAI_ROSTER },
    creative: { defaultModel: "gpt-5.4", selectableModels: OPENAI_ROSTER },
  },
  features: {
    nativeMCP: false,
    promptCaching: "system-auto",
    thinking: "reasoning-tokens",
  },
};
