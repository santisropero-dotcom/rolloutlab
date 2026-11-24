/**
 * Where a rollout is right now, and which moves are allowed from there.
 *
 * Versions (`rollouts.ts`) say which stages a rollout goes through; this
 * module tracks progress through one of them. It is a small state machine:
 *
 *   not_started ──start──▶ running ──advance──▶ running … ──advance──▶ completed
 *                           │   ▲                                         │
 *                       pause   resume                                    │
 *                           ▼   │                                         │
 *                          paused ──roll_back──▶ rolled_back ◀──roll_back─┘
 *
 * `running` can also roll back directly. `start` is allowed again after a
 * rollback, and after completion once a newer version exists.
 *
 * A started rollout stays on the version it was started with. Publishing a
 * new version does not move a rollout that is already under way, so a stage
 * can never jump because someone edited the plan.
 */

import type { RolloutVersion } from "./rollouts.js";

export const ROLLOUT_STATUSES = [
  "not_started",
  "running",
  "paused",
  "completed",
  "rolled_back",
] as const;
export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number];

export const TRANSITION_ACTIONS = ["start", "advance", "pause", "resume", "roll_back"] as const;
export type TransitionAction = (typeof TRANSITION_ACTIONS)[number];

/** Actions that must say why, so the history explains every stop. */
export const ACTIONS_NEEDING_REASON: readonly TransitionAction[] = ["pause", "roll_back"];

/** Actions that widen exposure, refused on archived flags. */
const WIDENING_ACTIONS: readonly TransitionAction[] = ["start", "advance", "resume"];

export interface RolloutState {
  status: RolloutStatus;
  /** The version being rolled out, or `null` before the first start. */
  version: number | null;
  /** Index into that version's stages, or `null` when no stage is active. */
  stageIndex: number | null;
  /** Share of identities currently inside the rollout. */
  percentage: number;
  /** Number of transitions so far; callers send it back as `baseSequence`. */
  sequence: number;
}

export const INITIAL_STATE: RolloutState = {
  status: "not_started",
  version: null,
  stageIndex: null,
  percentage: 0,
  sequence: 0,
};

export interface TransitionContext {
  /** All versions for the flag and environment, oldest first. */
  versions: readonly RolloutVersion[];
  flagArchived: boolean;
}

export type TransitionResult =
  | { ok: true; state: RolloutState }
  | { ok: false; problem: string };

function refuse(problem: string): TransitionResult {
  return { ok: false, problem };
}

/** The state at stage `index` of `version`, completing on the last stage. */
function atStage(version: RolloutVersion, index: number, sequence: number): RolloutState {
  const last = index === version.stages.length - 1;
  return {
    status: last ? "completed" : "running",
    version: version.version,
    stageIndex: index,
    percentage: version.stages[index]!.percentage,
    sequence,
  };
}

/**
 * Applies one action. Pure: the caller stores the result. Any move not drawn
 * in the diagram above is refused with a sentence saying what is allowed.
 */
export function applyTransition(
  current: RolloutState,
  action: TransitionAction,
  context: TransitionContext,
): TransitionResult {
  const sequence = current.sequence + 1;
  const { status } = current;

  if (context.flagArchived && WIDENING_ACTIONS.includes(action)) {
    return refuse(`The flag is archived; it can only be paused or rolled back`);
  }

  switch (action) {
    case "start": {
      const latest = context.versions[context.versions.length - 1];
      if (!latest) return refuse("Publish a rollout version before starting");
      if (status === "running" || status === "paused") {
        return refuse(`The rollout is already ${status} on version ${current.version}`);
      }
      if (status === "completed" && current.version !== null && latest.version <= current.version) {
        return refuse(
          `Version ${current.version} is already complete; publish a new version to start again`,
        );
      }
      return { ok: true, state: atStage(latest, 0, sequence) };
    }

    case "advance": {
      if (status !== "running") return refuse(`Only a running rollout can advance (it is ${status})`);
      const version = context.versions.find((v) => v.version === current.version);
      if (!version || current.stageIndex === null) {
        return refuse(`Version ${current.version} of this rollout no longer exists`);
      }
      return { ok: true, state: atStage(version, current.stageIndex + 1, sequence) };
    }

    case "pause":
      if (status !== "running") return refuse(`Only a running rollout can pause (it is ${status})`);
      return { ok: true, state: { ...current, status: "paused", sequence } };

    case "resume":
      if (status !== "paused") return refuse(`Only a paused rollout can resume (it is ${status})`);
      return { ok: true, state: { ...current, status: "running", sequence } };

    case "roll_back":
      if (status !== "running" && status !== "paused" && status !== "completed") {
        return refuse(`There is nothing to roll back (the rollout is ${status})`);
      }
      return {
        ok: true,
        state: { status: "rolled_back", version: current.version, stageIndex: null, percentage: 0, sequence },
      };
  }
}
