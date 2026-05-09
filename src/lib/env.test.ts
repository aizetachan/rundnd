import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("env Proxy", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("applies default for NODE_ENV when unset", async () => {
    Reflect.deleteProperty(process.env, "NODE_ENV");
    const { env } = await import("./env");
    expect(env.NODE_ENV).toBe("development");
  });

  it("applies default for LANGFUSE_HOST", async () => {
    Reflect.deleteProperty(process.env, "LANGFUSE_HOST");
    const { env } = await import("./env");
    expect(env.LANGFUSE_HOST).toBe("https://us.cloud.langfuse.com");
  });

  it("leaves optional keys undefined when unset", async () => {
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    const { env } = await import("./env");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("ownKeys works for spread/destructure", async () => {
    const { env } = await import("./env");
    const keys = Object.keys(env);
    expect(keys).toContain("NODE_ENV");
    expect(keys).toContain("NEXT_PUBLIC_APP_URL");
  });
});

describe("anthropicDefaults (fallback-only; authoritative config is per-campaign tier_models)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("declares probe / fast / thinking / creative keys with Anthropic model strings", async () => {
    const { anthropicDefaults } = await import("./env");
    expect(anthropicDefaults.probe).toBe("claude-haiku-4-5-20251001");
    expect(anthropicDefaults.fast).toBe("claude-haiku-4-5-20251001");
    // thinking: Sonnet 4.6 (changed 2026-04-23 from Opus 4.7 — ~5× cheaper
    // per-token, still supports extended thinking; Opus is overkill for
    // structured-verdict judgment across 10+ thinking-tier surfaces).
    expect(anthropicDefaults.thinking).toBe("claude-sonnet-4-6");
    expect(anthropicDefaults.creative).toBe("claude-opus-4-7");
  });

  it("matches ANTHROPIC_DEFAULTS from the providers registry (single source of truth)", async () => {
    const { anthropicDefaults } = await import("./env");
    const { ANTHROPIC_DEFAULTS } = await import("./providers");
    expect(anthropicDefaults).toEqual(ANTHROPIC_DEFAULTS);
  });
});
