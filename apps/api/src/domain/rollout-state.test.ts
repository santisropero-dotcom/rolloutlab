import { describe, expect, it } from "vitest";
import {
  applyTransition,
  INITIAL_STATE,
  ROLLOUT_STATUSES,
  TRANSITION_ACTIONS,
  type RolloutState,
  type RolloutStatus,
  type TransitionAction,
  type TransitionContext,
} from "./rollout-state.js";
import type { RolloutVersion } from "./rollouts.js";

function version(number: number, ...percentages: number[]): RolloutVersion {
  return {
    workspaceId: "storefront",
    flagKey: "new-checkout",
    environmentKey: "production",
    version: number,
    serve: true,
    stages: percentages.map((percentage) => ({ percentage })),
    salt: "new-checkout",
    note: "",
    createdBy: "alice",
    createdAt: "2026-01-12T10:00:00.000Z",
  };
}

const v1 = version(1, 10, 50, 100);
const context: TransitionContext = { versions: [v1], flagArchived: false };

/** Applies actions in order and fails the test on the first refusal. */
function run(actions: TransitionAction[], ctx = context, from = INITIAL_STATE): RolloutState {
  return actions.reduce((state, action) => {
    const result = applyTransition(state, action, ctx);
    if (!result.ok) throw new Error(`${action} refused: ${result.problem}`);
    return result.state;
  }, from);
}

/** One reachable state per status, on version 1. */
const reachable: Record<RolloutStatus, TransitionAction[]> = {
  not_started: [],
  running: ["start"],
  paused: ["start", "pause"],
  completed: ["start", "advance", "advance"],
  rolled_back: ["start", "roll_back"],
};

/** Every move the diagram in rollout-state.ts allows, from the states above. */
const allowed: Record<RolloutStatus, TransitionAction[]> = {
  not_started: ["start"],
  running: ["advance", "pause", "roll_back"],
  paused: ["resume", "roll_back"],
  completed: ["roll_back"],
  rolled_back: ["start"],
};

describe("applyTransition", () => {
  it("walks a plan stage by stage to completion", () => {
    const started = run(["start"]);
    expect(started).toEqual({
      status: "running",
      version: 1,
      stageIndex: 0,
      percentage: 10,
      sequence: 1,
    });
    expect(run(["start", "advance"])).toMatchObject({ status: "running", percentage: 50 });
    expect(run(["start", "advance", "advance"])).toEqual({
      status: "completed",
      version: 1,
      stageIndex: 2,
      percentage: 100,
      sequence: 3,
    });
  });

  it("completes immediately when the only stage is 100 %", () => {
    const ctx = { versions: [version(1, 100)], flagArchived: false };
    expect(run(["start"], ctx)).toMatchObject({ status: "completed", percentage: 100 });
  });

  it("keeps the stage while paused and continues from it", () => {
    const paused = run(["start", "advance", "pause"]);
    expect(paused).toMatchObject({ status: "paused", stageIndex: 1, percentage: 50 });
    expect(run(["resume", "advance"], context, paused)).toMatchObject({
      status: "completed",
      percentage: 100,
    });
  });

  it("drops exposure to zero on rollback", () => {
    expect(run(["start", "advance", "roll_back"])).toEqual({
      status: "rolled_back",
      version: 1,
      stageIndex: null,
      percentage: 0,
      sequence: 3,
    });
  });

  for (const status of ROLLOUT_STATUSES) {
    for (const action of TRANSITION_ACTIONS) {
      const ok = allowed[status].includes(action);
      it(`${ok ? "allows" : "rejects"} ${action} from ${status}`, () => {
        // Only version 1 exists here, so `start` from `completed` is refused;
        // restarting on a newer version is covered below.
        const result = applyTransition(run(reachable[status]), action, context);
        expect(result.ok).toBe(ok);
        if (!result.ok) expect(result.problem).not.toBe("");
      });
    }
  }

  it("rejects an invalid transition without touching the state", () => {
    const running = run(["start"]);
    const snapshot = structuredClone(running);
    const result = applyTransition(running, "resume", context);
    expect(result).toEqual({
      ok: false,
      problem: "Only a paused rollout can resume (it is running)",
    });
    expect(running).toEqual(snapshot);
  });

  it("needs a published version to start", () => {
    const result = applyTransition(INITIAL_STATE, "start", { versions: [], flagArchived: false });
    expect(result).toEqual({ ok: false, problem: "Publish a rollout version before starting" });
  });

  it("stays on the started version when a newer one is published", () => {
    const running = run(["start"]);
    const newer = { versions: [v1, version(2, 5, 25, 100)], flagArchived: false };
    expect(run(["advance"], newer, running)).toMatchObject({ version: 1, percentage: 50 });
  });

  it("restarts a completed rollout only on a newer version", () => {
    const completed = run(reachable.completed);
    const newer = { versions: [v1, version(2, 5, 25, 100)], flagArchived: false };
    expect(run(["start"], newer, completed)).toMatchObject({
      status: "running",
      version: 2,
      percentage: 5,
    });
  });

  it("restarts after a rollback from the first stage of the latest version", () => {
    const rolledBack = run(["start", "advance", "roll_back"]);
    expect(run(["start"], context, rolledBack)).toMatchObject({
      status: "running",
      version: 1,
      stageIndex: 0,
      percentage: 10,
    });
  });

  it("only lets an archived flag pause or roll back", () => {
    const archived = { versions: [v1], flagArchived: true };
    const running = run(["start"]);
    expect(applyTransition(running, "advance", archived).ok).toBe(false);
    expect(applyTransition(INITIAL_STATE, "start", archived).ok).toBe(false);
    const paused = run(["pause"], archived, running);
    expect(applyTransition(paused, "resume", archived).ok).toBe(false);
    expect(run(["roll_back"], archived, paused).status).toBe("rolled_back");
  });

  it("counts every transition in the sequence", () => {
    expect(run(["start", "pause", "resume", "advance", "roll_back"]).sequence).toBe(5);
  });
});
