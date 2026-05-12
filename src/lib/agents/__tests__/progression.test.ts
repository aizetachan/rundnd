import { describe, expect, it } from "vitest";
import { applyXpDelta, levelForXp, levelUpStatBonus, xpAward, xpForLevel } from "../progression";

describe("xpForLevel", () => {
  it("level 1 always costs 0", () => {
    for (const g of ["spike", "top_heavy", "flat", "compressed"] as const) {
      expect(xpForLevel(1, g)).toBe(0);
    }
  });

  it("flat gradient is linear 100/level", () => {
    expect(xpForLevel(2, "flat")).toBe(100);
    expect(xpForLevel(5, "flat")).toBe(400);
    expect(xpForLevel(10, "flat")).toBe(900);
  });

  it("spike gradient grows quadratically", () => {
    expect(xpForLevel(2, "spike")).toBe(100);
    expect(xpForLevel(3, "spike")).toBe(400);
    expect(xpForLevel(5, "spike")).toBe(1600);
  });
});

describe("levelForXp", () => {
  it("0 xp is level 1", () => {
    expect(levelForXp(0)).toBe(1);
  });

  it("crossing the threshold returns the higher level (flat)", () => {
    expect(levelForXp(100, "flat")).toBe(2);
    expect(levelForXp(99, "flat")).toBe(1);
    expect(levelForXp(900, "flat")).toBe(10);
  });
});

describe("xpAward", () => {
  it("MINOR success awards more than MINOR fail", () => {
    expect(xpAward("MINOR", "success")).toBeGreaterThan(xpAward("MINOR", "fail"));
  });

  it("CLIMACTIC dominates SIGNIFICANT dominates MINOR", () => {
    expect(xpAward("CLIMACTIC", "success")).toBeGreaterThan(xpAward("SIGNIFICANT", "success"));
    expect(xpAward("SIGNIFICANT", "success")).toBeGreaterThan(xpAward("MINOR", "success"));
  });
});

describe("applyXpDelta", () => {
  it("returns leveledUp=true when crossing a level threshold", () => {
    const out = applyXpDelta(99, 5, "flat");
    expect(out.newXp).toBe(104);
    expect(out.newLevel).toBe(2);
    expect(out.leveledUp).toBe(true);
  });

  it("returns leveledUp=false within the same level", () => {
    const out = applyXpDelta(100, 50, "flat");
    expect(out.newLevel).toBe(2);
    expect(out.leveledUp).toBe(false);
  });

  it("clamps XP at zero", () => {
    const out = applyXpDelta(50, -200, "flat");
    expect(out.newXp).toBe(0);
  });
});

describe("levelUpStatBonus", () => {
  it("spike/top_heavy give bigger bonuses than flat/compressed", () => {
    expect(levelUpStatBonus("spike")).toBeGreaterThan(levelUpStatBonus("flat"));
    expect(levelUpStatBonus("top_heavy")).toBeGreaterThan(levelUpStatBonus("compressed"));
  });
});
