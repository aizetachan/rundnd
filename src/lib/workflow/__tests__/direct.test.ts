import { describe, expect, it } from "vitest";
import { shouldFireHybrid } from "../direct";

describe("shouldFireHybrid", () => {
  it("fires at turn 3 with epicness 0.6", () => {
    expect(shouldFireHybrid(3, 0.6)).toBe(true);
  });

  it("does not fire before turn 3", () => {
    expect(shouldFireHybrid(2, 1.0)).toBe(false);
  });

  it("does not fire on non-multiples of 3", () => {
    expect(shouldFireHybrid(4, 1.0)).toBe(false);
    expect(shouldFireHybrid(5, 1.0)).toBe(false);
    expect(shouldFireHybrid(6, 1.0)).toBe(true);
  });

  it("does not fire below epicness threshold", () => {
    expect(shouldFireHybrid(6, 0.4)).toBe(false);
    expect(shouldFireHybrid(6, 0.59)).toBe(false);
  });

  it("fires on turn 9 / 12 / 15 at threshold", () => {
    expect(shouldFireHybrid(9, 0.6)).toBe(true);
    expect(shouldFireHybrid(12, 0.7)).toBe(true);
    expect(shouldFireHybrid(15, 0.9)).toBe(true);
  });
});
