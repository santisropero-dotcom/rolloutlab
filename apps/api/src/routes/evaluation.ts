import {
  evaluateFlag,
  valueTypeOf,
  type EvaluationContext,
  type FlagValue,
} from "@rolloutlab/evaluator";
import type { FastifyInstance } from "fastify";
import { authorize } from "../auth.js";
import { ApiError } from "../errors.js";
import type { MemoryStore } from "../store.js";

const MAX_CONTEXT_ATTRIBUTES = 50;
const MAX_ATTRIBUTE_NAME_LENGTH = 64;
const MAX_ATTRIBUTE_VALUE_LENGTH = 1000;

const evaluationParams = {
  type: "object",
  required: ["workspaceId", "environmentKey", "flagKey"],
  properties: {
    workspaceId: { type: "string", minLength: 1 },
    environmentKey: { type: "string", minLength: 1 },
    flagKey: { type: "string", minLength: 1 },
  },
} as const;

// Value types are checked in the handler: with Fastify's type coercion a JSON
// schema would quietly turn `"true"` into `true` or `30` into `"30"`.
const evaluationBody = {
  type: "object",
  required: ["defaultValue"],
  additionalProperties: false,
  properties: {
    defaultValue: {},
    context: { type: "object", maxProperties: MAX_CONTEXT_ATTRIBUTES },
  },
} as const;

interface EvaluationParams {
  workspaceId: string;
  environmentKey: string;
  flagKey: string;
}

interface EvaluationBody {
  defaultValue: unknown;
  context?: Record<string, unknown>;
}

function requestProblem(body: EvaluationBody): string | undefined {
  if (valueTypeOf(body.defaultValue) === undefined) {
    return "defaultValue must be a boolean, string or number";
  }
  for (const [name, value] of Object.entries(body.context ?? {})) {
    if (name.length === 0 || name.length > MAX_ATTRIBUTE_NAME_LENGTH) {
      return `Context attribute names must be 1-${MAX_ATTRIBUTE_NAME_LENGTH} characters`;
    }
    if (value !== null && valueTypeOf(value) === undefined) {
      return `Context attribute "${name}" must be a string, number, boolean or null`;
    }
    if (typeof value === "string" && value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      return `Context attribute "${name}" is longer than ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`;
    }
  }
  return undefined;
}

export function registerEvaluationRoutes(app: FastifyInstance, store: MemoryStore): void {
  /**
   * Evaluates one flag for one identity. Unknown flags and type mismatches are
   * answered with 200 and the caller's default plus an error code, so clients
   * handle every outcome the same way; only access and request problems are
   * HTTP errors.
   */
  app.post<{ Params: EvaluationParams; Body: EvaluationBody }>(
    "/workspaces/:workspaceId/environments/:environmentKey/flags/:flagKey/evaluate",
    { schema: { params: evaluationParams, body: evaluationBody } },
    async (request) => {
      const { workspaceId, environmentKey, flagKey } = request.params;
      authorize(store, request, workspaceId, "workspace:read");
      const problem = requestProblem(request.body);
      if (problem) throw new ApiError(400, "VALIDATION_FAILED", problem);
      const config = store.getFlagConfig(workspaceId, flagKey, environmentKey);
      const context = (request.body.context ?? {}) as EvaluationContext;
      return evaluateFlag(flagKey, config, context, request.body.defaultValue as FlagValue);
    },
  );
}
