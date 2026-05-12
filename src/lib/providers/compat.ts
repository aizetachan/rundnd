/**
 * M6.5 — Cross-provider compat layer.
 *
 * Goal (ROADMAP §23 M6.5): normalize feature gaps between provider
 * KAs so downstream code doesn't fork on `provider === "X"` for every
 * capability check. With all four KAs built (Anthropic, Google,
 * OpenAI, OpenRouter), the real gaps are visible and can be queried
 * via a single API.
 *
 * Today's surface is a feature-flag query API. Graceful-degradation
 * shims (MCP-to-inlined-tool, breakpoint-cache-to-context-id) and
 * failover orchestration are scaffolded but minimal — they land
 * fully when a downstream feature actually depends on them.
 */
import { getProvider } from "./registry";
import type { ProviderId } from "./types";

/**
 * Capabilities a downstream consumer might branch on. Adding a new
 * capability means: (1) add to this union, (2) implement the lookup
 * in `supports()`. The hard typing prevents typos at the call site.
 */
export type Capability =
  | "native_mcp"
  | "prompt_cache_breakpoint"
  | "prompt_cache_context_id"
  | "prompt_cache_system_auto"
  | "extended_thinking_adaptive"
  | "extended_thinking_native"
  | "reasoning_tokens"
  | "free_form_models"
  | "function_calling";

/**
 * True when the provider supports the capability. Single source of
 * truth so consumers stop hardcoding `provider === "anthropic"` for
 * MCP-style checks.
 */
export function supports(providerId: ProviderId, cap: Capability): boolean {
  const p = getProvider(providerId);
  switch (cap) {
    case "native_mcp":
      return p.features.nativeMCP;
    case "prompt_cache_breakpoint":
      return p.features.promptCaching === "breakpoint";
    case "prompt_cache_context_id":
      return p.features.promptCaching === "context-id";
    case "prompt_cache_system_auto":
      return p.features.promptCaching === "system-auto";
    case "extended_thinking_adaptive":
      return p.features.thinking === "adaptive";
    case "extended_thinking_native":
      return p.features.thinking === "native";
    case "reasoning_tokens":
      return p.features.thinking === "reasoning-tokens";
    case "free_form_models":
      return p.allowFreeFormModels === true;
    case "function_calling":
      // All four providers support function calling as of M5.5.
      // Anthropic via Agent SDK; Google + OpenAI + OpenRouter via
      // their respective native APIs. OpenRouter inherits depending
      // on the underlying model, but the HTTP surface accepts it.
      return true;
  }
}

/**
 * Cross-provider gap snapshot — useful for audit / failover decision.
 * Returns a record of each capability mapped to the set of providers
 * that support it. Documented for the compat-audit deliverable in
 * ROADMAP §23 M6.5.
 */
export function capabilityMatrix(): Record<Capability, ProviderId[]> {
  const providers: ProviderId[] = ["anthropic", "google", "openai", "openrouter"];
  const caps: Capability[] = [
    "native_mcp",
    "prompt_cache_breakpoint",
    "prompt_cache_context_id",
    "prompt_cache_system_auto",
    "extended_thinking_adaptive",
    "extended_thinking_native",
    "reasoning_tokens",
    "free_form_models",
    "function_calling",
  ];
  const matrix = {} as Record<Capability, ProviderId[]>;
  for (const cap of caps) {
    matrix[cap] = providers.filter((p) => supports(p, cap));
  }
  return matrix;
}

/**
 * Failover candidates for a primary provider. When the primary returns
 * 5xx or hits rate limits, the orchestrator may retry on one of these.
 *
 * Conservative ordering: prefer the closest-substance alternative
 * (Anthropic ↔ Google for thinking-tier work; OpenAI as a different
 * voice profile). OpenRouter is the last-resort grab-bag.
 */
export function failoverCandidates(primary: ProviderId): ProviderId[] {
  switch (primary) {
    case "anthropic":
      return ["google", "openai", "openrouter"];
    case "google":
      return ["anthropic", "openai", "openrouter"];
    case "openai":
      return ["anthropic", "google", "openrouter"];
    case "openrouter":
      return ["anthropic", "google", "openai"];
    default:
      return [];
  }
}
