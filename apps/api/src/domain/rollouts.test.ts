import { describe, expect, it } from "vitest";
import { MAX_STAGES, stageProblems } from "./rollouts.js";

const stages = (...percentages: number[]) => percentages.map((percentage) => ({ percentage }));

describe("stageProblems", () => {
  it.each([
    [[100]],
    [[10, 50, 100]],
    [[0.5, 12.25, 100]],
  ])("accepts %j", (percentages) => {
    expect(stageProblems(stages(...percentages))).toEqual([]);
  });

  it("needs at least one stage", () => {
    expect(stageProblems([])).toEqual(["A rollout needs at least one stage"]);
  });

  it("limits the number of stages", () => {
    const many = Array.from({ length: MAX_STAGES + 1 }, (_, i) => i + 1);
    many[many.length - 1] = 100;
    expect(stageProblems(stages(...many))).toContain(
      `A rollout can have at most ${MAX_STAGES} stages`,
    );
  });

  it.each([
    ["zero", [0, 100]],
    ["a negative percentage", [-5, 100]],
    ["more than 100", [10, 150]],
    ["NaN", [Number.NaN, 100]],
  ])("rejects %s", (_label, percentages) => {
    expect(stageProblems(stages(...percentages)).join(" ")).toContain(
      "percentage must be above 0 and at most 100",
    );
  });

  it("rejects more than two decimals", () => {
    expect(stageProblems(stages(12.345, 100))).toEqual([
      "Stage 1: percentage takes at most two decimals",
    ]);
  });

  it("rejects stages that do not increase", () => {
    expect(stageProblems(stages(50, 50, 100))).toEqual([
      "Stage 2: percentage must be higher than stage 1",
    ]);
    expect(stageProblems(stages(50, 10, 100))).toEqual([
      "Stage 2: percentage must be higher than stage 1",
    ]);
  });

  it("requires the last stage to reach 100 %", () => {
    expect(stageProblems(stages(10, 50))).toEqual(["The last stage must be 100 %"]);
  });
});
