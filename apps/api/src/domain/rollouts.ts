/**
 * Rollout plans: how far a flag is released in one environment, stage by stage.
 *
 * A plan is stored as numbered, immutable versions. Changing the plan creates
 * a new version instead of editing the old one, so a reviewer can always see
 * which plan a past decision was made against.
 *
 * Cohort stability: a version only lists percentages. Which identities fall
 * inside a percentage is decided by the flag's salt (see
 * `packages/evaluator/src/bucketing.ts`), so publishing a new version, or
 * moving to the next stage, only adds or removes identities at the edge. Each
 * version records the salt it was written for, which makes a later salt
 * rotation visible next to the plan.
 */

export const MAX_STAGES = 10;
export const MAX_NOTE_LENGTH = 500;

export interface RolloutStage {
  /** 0–100 with up to two decimals, like targeting rollouts. */
  percentage: number;
}

export interface RolloutVersion {
  workspaceId: string;
  flagKey: string;
  environmentKey: string;
  /** 1, 2, 3, … per flag and environment. */
  version: number;
  /** The value served to identities inside the current stage. */
  serve: boolean;
  stages: RolloutStage[];
  /** The flag's salt when this version was created. */
  salt: string;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface NewRolloutVersion {
  serve: boolean;
  stages: RolloutStage[];
  note?: string;
  /**
   * The latest version the author saw (`0` when there is none). A mismatch
   * means someone else published in between, and the request is refused.
   */
  baseVersion: number;
}

function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

/**
 * Problems with a stage list, or an empty list when it is usable.
 *
 * Stages must strictly increase: a rollout only widens, and pausing or rolling
 * back is a transition, not a stage. The last stage must reach 100 % so every
 * plan has a defined end.
 */
export function stageProblems(stages: readonly RolloutStage[]): string[] {
  const problems: string[] = [];
  if (stages.length === 0) return ["A rollout needs at least one stage"];
  if (stages.length > MAX_STAGES) {
    problems.push(`A rollout can have at most ${MAX_STAGES} stages`);
  }
  stages.forEach((stage, index) => {
    const { percentage } = stage;
    const label = `Stage ${index + 1}`;
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      problems.push(`${label}: percentage must be above 0 and at most 100`);
      return;
    }
    if (!hasAtMostTwoDecimals(percentage)) {
      problems.push(`${label}: percentage takes at most two decimals`);
    }
    const previous = stages[index - 1];
    if (previous && percentage <= previous.percentage) {
      problems.push(`${label}: percentage must be higher than stage ${index}`);
    }
  });
  const last = stages[stages.length - 1];
  if (last && last.percentage !== 100) {
    problems.push("The last stage must be 100 %");
  }
  return problems;
}
