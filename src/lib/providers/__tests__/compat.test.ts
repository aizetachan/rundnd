import { describe, expect, it } from "vitest";
import { capabilityMatrix, failoverCandidates, supports } from "../compat";

describe("supports", () => {
  it("anthropic alone has native MCP", () => {
    expect(supports("anthropic", "native_mcp")).toBe(true);
    expect(supports("google", "native_mcp")).toBe(false);
    expect(supports("openai", "native_mcp")).toBe(false);
    expect(supports("openrouter", "native_mcp")).toBe(false);
  });

  it("prompt caching mechanisms differ per provider", () => {
    expect(supports("anthropic", "prompt_cache_breakpoint")).toBe(true);
    expect(supports("google", "prompt_cache_context_id")).toBe(true);
    expect(supports("openai", "prompt_cache_system_auto")).toBe(true);
    expect(supports("openrouter", "prompt_cache_system_auto")).toBe(false);
  });

  it("extended-thinking shape differs per provider", () => {
    expect(supports("anthropic", "extended_thinking_adaptive")).toBe(true);
    expect(supports("google", "extended_thinking_native")).toBe(true);
    expect(supports("openai", "reasoning_tokens")).toBe(true);
  });

  it("only OpenRouter allows free-form model IDs", () => {
    expect(supports("openrouter", "free_form_models")).toBe(true);
    expect(supports("anthropic", "free_form_models")).toBe(false);
  });

  it("all four providers support function_calling at M5.5+", () => {
    for (const p of ["anthropic", "google", "openai", "openrouter"] as const) {
      expect(supports(p, "function_calling")).toBe(true);
    }
  });
});

describe("capabilityMatrix", () => {
  it("returns a non-empty mapping for every capability", () => {
    const m = capabilityMatrix();
    expect(m.native_mcp).toEqual(["anthropic"]);
    expect(m.function_calling.sort()).toEqual(
      ["anthropic", "google", "openai", "openrouter"].sort(),
    );
  });
});

describe("failoverCandidates", () => {
  it("excludes the primary and lists the rest", () => {
    expect(failoverCandidates("anthropic")).not.toContain("anthropic");
    expect(failoverCandidates("anthropic")).toHaveLength(3);
    expect(failoverCandidates("google")).not.toContain("google");
    expect(failoverCandidates("openai")).not.toContain("openai");
  });
});
