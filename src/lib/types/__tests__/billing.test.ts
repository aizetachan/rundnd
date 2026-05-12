import { describe, expect, it } from "vitest";
import { PRICING_TIERS, creditsToUsd, usdToCredits } from "../billing";

describe("billing conversions", () => {
  it("usdToCredits rounds to the nearest cent", () => {
    expect(usdToCredits(0.06)).toBe(6);
    expect(usdToCredits(0.005)).toBeGreaterThanOrEqual(0);
    expect(usdToCredits(10)).toBe(1000);
  });

  it("creditsToUsd is the inverse", () => {
    expect(creditsToUsd(1000)).toBe(10);
    expect(creditsToUsd(1)).toBeCloseTo(0.01);
  });
});

describe("PRICING_TIERS", () => {
  it("includes starter / creator / studio in ascending USD", () => {
    expect(PRICING_TIERS.map((t) => t.id)).toEqual(["starter", "creator", "studio"]);
    const usds = PRICING_TIERS.map((t) => t.monthlyUsd);
    expect(usds[0]).toBeLessThan(usds[1] as number);
    expect(usds[1]).toBeLessThan(usds[2] as number);
  });

  it("credits-per-USD ratio improves at higher tiers", () => {
    const ratios = PRICING_TIERS.map((t) => t.monthlyCredits / t.monthlyUsd);
    expect(ratios[2]).toBeGreaterThanOrEqual(ratios[0] as number);
  });
});
