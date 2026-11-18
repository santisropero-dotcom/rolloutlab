import type { FastifyInstance } from "fastify";
import { authorize } from "../auth.js";
import {
  MAX_CONDITIONS,
  MAX_RULES,
  MAX_VALUES,
  OPERATORS,
  ruleListProblems,
  type TargetingRule,
} from "../domain/targeting.js";
import { ApiError } from "../errors.js";
import type { MemoryStore } from "../store.js";
import { KEY_PATTERN } from "./workspaces.js";

const targetingParams = {
  type: "object",
  required: ["workspaceId", "flagKey", "environmentKey"],
  properties: {
    workspaceId: { type: "string", minLength: 1 },
    flagKey: { type: "string", minLength: 1 },
    environmentKey: { type: "string", minLength: 1 },
  },
} as const;

const conditionSchema = {
  type: "object",
  required: ["attribute", "operator", "values"],
  additionalProperties: false,
  properties: {
    attribute: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" },
    operator: { type: "string", enum: [...OPERATORS] },
    values: {
      type: "array",
      minItems: 1,
      maxItems: MAX_VALUES,
      items: { type: "string", maxLength: 200 },
    },
  },
} as const;

const ruleSchema = {
  type: "object",
  required: ["id", "conditions", "serve"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: KEY_PATTERN },
    description: { type: "string", maxLength: 200 },
    conditions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CONDITIONS,
      items: conditionSchema,
    },
    serve: { type: "boolean" },
    rollout: {
      type: "object",
      required: ["percentage"],
      additionalProperties: false,
      properties: { percentage: { type: "number", minimum: 0, maximum: 100 } },
    },
  },
} as const;

const putTargetingBody = {
  type: "object",
  required: ["rules"],
  additionalProperties: false,
  properties: {
    rules: { type: "array", maxItems: MAX_RULES, items: ruleSchema },
  },
} as const;

interface TargetingParams {
  workspaceId: string;
  flagKey: string;
  environmentKey: string;
}

type RuleInput = Omit<TargetingRule, "description"> & { description?: string };

export function registerTargetingRoutes(app: FastifyInstance, store: MemoryStore): void {
  const path = "/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rules";

  app.get<{ Params: TargetingParams }>(
    path,
    { schema: { params: targetingParams } },
    async (request) => {
      const { workspaceId, flagKey, environmentKey } = request.params;
      authorize(store, request, workspaceId, "workspace:read");
      return store.getTargeting(workspaceId, flagKey, environmentKey);
    },
  );

  app.put<{ Params: TargetingParams; Body: { rules: RuleInput[] } }>(
    path,
    { schema: { params: targetingParams, body: putTargetingBody } },
    async (request) => {
      const { workspaceId, flagKey, environmentKey } = request.params;
      authorize(store, request, workspaceId, "flags:write");
      const rules: TargetingRule[] = request.body.rules.map((rule) => ({
        id: rule.id,
        description: rule.description ?? "",
        conditions: rule.conditions,
        serve: rule.serve,
        ...(rule.rollout && { rollout: { percentage: rule.rollout.percentage } }),
      }));
      const problems = ruleListProblems(rules);
      if (problems.length > 0) {
        throw new ApiError(400, "VALIDATION_FAILED", problems.join("; "));
      }
      return store.setTargeting(workspaceId, flagKey, environmentKey, rules);
    },
  );
}
