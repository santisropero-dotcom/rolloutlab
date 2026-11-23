import type { FastifyInstance } from "fastify";
import { authorize } from "../auth.js";
import {
  MAX_NOTE_LENGTH,
  MAX_STAGES,
  stageProblems,
  type NewRolloutVersion,
} from "../domain/rollouts.js";
import { ApiError } from "../errors.js";
import type { MemoryStore } from "../store.js";

const rolloutParams = {
  type: "object",
  required: ["workspaceId", "flagKey", "environmentKey"],
  properties: {
    workspaceId: { type: "string", minLength: 1 },
    flagKey: { type: "string", minLength: 1 },
    environmentKey: { type: "string", minLength: 1 },
  },
} as const;

const versionParams = {
  type: "object",
  required: [...rolloutParams.required, "version"],
  properties: {
    ...rolloutParams.properties,
    version: { type: "integer", minimum: 1 },
  },
} as const;

const newVersionBody = {
  type: "object",
  required: ["serve", "stages", "baseVersion"],
  additionalProperties: false,
  properties: {
    serve: { type: "boolean" },
    stages: {
      type: "array",
      minItems: 1,
      maxItems: MAX_STAGES,
      items: {
        type: "object",
        required: ["percentage"],
        additionalProperties: false,
        properties: { percentage: { type: "number" } },
      },
    },
    note: { type: "string", maxLength: MAX_NOTE_LENGTH },
    baseVersion: { type: "integer", minimum: 0 },
  },
} as const;

interface RolloutParams {
  workspaceId: string;
  flagKey: string;
  environmentKey: string;
}

interface VersionParams extends RolloutParams {
  version: number;
}

export function registerRolloutRoutes(app: FastifyInstance, store: MemoryStore): void {
  const path = "/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rollout";

  app.get<{ Params: RolloutParams }>(
    `${path}/versions`,
    { schema: { params: rolloutParams } },
    async (request) => {
      const { workspaceId, flagKey, environmentKey } = request.params;
      authorize(store, request, workspaceId, "workspace:read");
      const items = store.listRolloutVersions(workspaceId, flagKey, environmentKey);
      return { items, latestVersion: items.length };
    },
  );

  app.get<{ Params: VersionParams }>(
    `${path}/versions/:version`,
    { schema: { params: versionParams } },
    async (request) => {
      const { workspaceId, flagKey, environmentKey, version } = request.params;
      authorize(store, request, workspaceId, "workspace:read");
      const found = store.getRolloutVersion(workspaceId, flagKey, environmentKey, version);
      if (!found) {
        throw new ApiError(404, "NOT_FOUND", `Rollout version ${version} not found`);
      }
      return found;
    },
  );

  app.post<{ Params: RolloutParams; Body: NewRolloutVersion }>(
    `${path}/versions`,
    { schema: { params: rolloutParams, body: newVersionBody } },
    async (request, reply) => {
      const { workspaceId, flagKey, environmentKey } = request.params;
      const membership = authorize(store, request, workspaceId, "flags:write");
      const problems = stageProblems(request.body.stages);
      if (problems.length > 0) {
        throw new ApiError(400, "VALIDATION_FAILED", problems.join("; "));
      }
      const created = store.createRolloutVersion(
        workspaceId,
        flagKey,
        environmentKey,
        request.body,
        membership.userId,
      );
      return reply.code(201).send(created);
    },
  );
}
