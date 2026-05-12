import { describe, expect, it } from "vitest";
import { shouldSnapshot } from "../snapshot";

describe("shouldSnapshot", () => {
  it("fires on multiples of 10", () => {
    expect(shouldSnapshot(10)).toBe(true);
    expect(shouldSnapshot(20)).toBe(true);
    expect(shouldSnapshot(100)).toBe(true);
  });

  it("does not fire on non-multiples", () => {
    expect(shouldSnapshot(1)).toBe(false);
    expect(shouldSnapshot(9)).toBe(false);
    expect(shouldSnapshot(11)).toBe(false);
  });

  it("does not fire at or before turn 0", () => {
    expect(shouldSnapshot(0)).toBe(false);
    expect(shouldSnapshot(-1)).toBe(false);
  });
});

describe("shouldCompact", () => {
  it("does not fire when working memory fits the budget", async () => {
    const { shouldCompact } = await import("@/lib/agents/compactor");
    expect(shouldCompact(5, 5)).toBe(false);
    expect(shouldCompact(10, 10)).toBe(false);
  });

  it("fires every 5 turns past the budget", async () => {
    const { shouldCompact } = await import("@/lib/agents/compactor");
    // budget=10, size=11 (over budget). turn 15 → (15-10) % 5 === 0
    expect(shouldCompact(15, 11)).toBe(true);
    expect(shouldCompact(20, 15)).toBe(true);
    expect(shouldCompact(16, 11)).toBe(false);
  });
});
