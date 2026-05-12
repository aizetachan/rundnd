import { describe, expect, it } from "vitest";
import { type ForeshadowSeedRow, decideLifecycle, detectConvergence } from "../foreshadow";

function seed(overrides: Partial<ForeshadowSeedRow> = {}): ForeshadowSeedRow {
  return {
    id: "s1",
    name: "Vicious calls Spike",
    status: "PLANTED",
    payoffWindowMin: 3,
    payoffWindowMax: 10,
    plantedAtTurn: 1,
    ...overrides,
  };
}

describe("decideLifecycle", () => {
  it("PLANTED → GROWING when age >= payoffWindowMin", () => {
    const t = decideLifecycle(seed({ status: "PLANTED", plantedAtTurn: 1 }), 4);
    expect(t).not.toBeNull();
    expect(t?.to).toBe("GROWING");
  });

  it("PLANTED stays PLANTED while age < payoffWindowMin", () => {
    expect(decideLifecycle(seed({ status: "PLANTED", plantedAtTurn: 1 }), 2)).toBeNull();
  });

  it("any non-terminal → OVERDUE when age > payoffWindowMax", () => {
    for (const status of ["PLANTED", "GROWING", "CALLBACK"] as const) {
      const t = decideLifecycle(
        seed({ status, plantedAtTurn: 1, payoffWindowMin: 3, payoffWindowMax: 5 }),
        10,
      );
      expect(t?.to).toBe("OVERDUE");
    }
  });

  it("RESOLVED + ABANDONED are terminal", () => {
    expect(decideLifecycle(seed({ status: "RESOLVED", plantedAtTurn: 1 }), 100)).toBeNull();
    expect(decideLifecycle(seed({ status: "ABANDONED", plantedAtTurn: 1 }), 100)).toBeNull();
  });

  it("OVERDUE doesn't re-transition", () => {
    expect(decideLifecycle(seed({ status: "OVERDUE", plantedAtTurn: 1 }), 100)).toBeNull();
  });
});

describe("detectConvergence", () => {
  it("returns empty list when only one GROWING seed wants the window", () => {
    const seeds = [
      seed({
        id: "a",
        status: "GROWING",
        plantedAtTurn: 1,
        payoffWindowMin: 3,
        payoffWindowMax: 5,
      }),
      seed({
        id: "b",
        status: "PLANTED",
        plantedAtTurn: 1,
        payoffWindowMin: 3,
        payoffWindowMax: 5,
      }),
    ];
    expect(detectConvergence(seeds, 4)).toEqual([]);
  });

  it("returns ids of all GROWING seeds whose windows overlap the current turn", () => {
    const seeds = [
      seed({
        id: "a",
        status: "GROWING",
        plantedAtTurn: 1,
        payoffWindowMin: 3,
        payoffWindowMax: 5,
      }),
      seed({
        id: "b",
        status: "GROWING",
        plantedAtTurn: 2,
        payoffWindowMin: 2,
        payoffWindowMax: 4,
      }),
    ];
    const ids = detectConvergence(seeds, 4);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("ignores non-GROWING statuses", () => {
    const seeds = [
      seed({ id: "a", status: "RESOLVED", plantedAtTurn: 1 }),
      seed({
        id: "b",
        status: "GROWING",
        plantedAtTurn: 1,
        payoffWindowMin: 3,
        payoffWindowMax: 5,
      }),
    ];
    expect(detectConvergence(seeds, 4)).toEqual([]);
  });
});
