import { DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES, MIN_WINDOW_MINUTES } from "@rolloutlab/metrics";

/** One flag in one environment whose telemetry the worker aggregates. */
export interface MetricsTarget {
  workspaceId: string;
  flagKey: string;
  environmentKey: string;
}

export interface WorkerConfig {
  apiUrl: string;
  /** Workspace member the worker acts as; needs a role that may send telemetry. */
  user: string;
  targets: MetricsTarget[];
  windowMinutes: number;
  intervalMs: number;
}

const DEFAULT_TARGETS = "storefront/new-checkout/production";
const KEY = /^[A-Za-z0-9._-]+$/;

/**
 * Reads the worker settings from the environment.
 *
 * `ROLLOUTLAB_METRICS_TARGETS` is a comma-separated list of
 * `workspace/flag/environment`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const apiUrl = (env.ROLLOUTLAB_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  const user = env.ROLLOUTLAB_WORKER_USER?.trim() || "bob";
  return {
    apiUrl,
    user,
    targets: parseTargets(env.ROLLOUTLAB_METRICS_TARGETS ?? DEFAULT_TARGETS),
    windowMinutes: wholeNumber(
      "ROLLOUTLAB_METRICS_WINDOW_MINUTES",
      env.ROLLOUTLAB_METRICS_WINDOW_MINUTES,
      DEFAULT_WINDOW_MINUTES,
      MIN_WINDOW_MINUTES,
      MAX_WINDOW_MINUTES,
    ),
    intervalMs: wholeNumber(
      "ROLLOUTLAB_WORKER_INTERVAL_MS",
      env.ROLLOUTLAB_WORKER_INTERVAL_MS,
      30_000,
      1_000,
      24 * 60 * 60 * 1000,
    ),
  };
}

export function parseTargets(value: string): MetricsTarget[] {
  const targets = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const pieces = part.split("/");
      if (pieces.length !== 3 || !pieces.every((piece) => KEY.test(piece))) {
        throw new Error(`Invalid metrics target "${part}"; expected workspace/flag/environment`);
      }
      const [workspaceId, flagKey, environmentKey] = pieces as [string, string, string];
      return { workspaceId, flagKey, environmentKey };
    });
  if (targets.length === 0) throw new Error("ROLLOUTLAB_METRICS_TARGETS lists no targets");
  return targets;
}

export function describeTarget(target: MetricsTarget): string {
  return `${target.workspaceId}/${target.flagKey}/${target.environmentKey}`;
}

function wholeNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}
