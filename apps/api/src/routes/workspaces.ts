import type { FastifyInstance } from "fastify";
import { authorize } from "../auth.js";
import type { FlagPatch, NewEnvironment, NewFlag } from "../domain/types.js";
import { ApiError } from "../errors.js";
import type { MemoryStore } from "../store.js";

const KEY_PATTERN = "^[a-z0-9][a-z0-9-]{0,62}$";

const workspaceParams = {
  type: "object",
  required: ["workspaceId"],
  properties: { workspaceId: { type: "string", minLength: 1 } },
} as const;

const flagParams = {
  type: "object",
  required: ["workspaceId", "flagKey"],
  properties: {
    workspaceId: { type: "string", minLength: 1 },
    flagKey: { type: "string", minLength: 1 },
  },
} as const;

const newEnvironmentBody = {
  type: "object",
  required: ["key", "name"],
  additionalProperties: false,
  properties: {
    key: { type: "string", pattern: KEY_PATTERN },
    name: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

const newFlagBody = {
  type: "object",
  required: ["key"],
  additionalProperties: false,
  properties: {
    key: { type: "string", pattern: KEY_PATTERN },
    description: { type: "string", maxLength: 500 },
    defaultValue: { type: "boolean" },
  },
} as const;

const flagPatchBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 500 },
    defaultValue: { type: "boolean" },
    archived: { type: "boolean" },
  },
} as const;

interface WorkspaceParams {
  workspaceId: string;
}

interface FlagParams extends WorkspaceParams {
  flagKey: string;
}

export function registerWorkspaceRoutes(app: FastifyInstance, store: MemoryStore): void {
  app.get<{ Params: WorkspaceParams }>(
    "/workspaces/:workspaceId/environments",
    { schema: { params: workspaceParams } },
    async (request) => {
      const { workspaceId } = request.params;
      authorize(store, request, workspaceId, "workspace:read");
      return { items: store.listEnvironments(workspaceId) };
    },
  );

  app.post<{ Params: WorkspaceParams; Body: NewEnvironment }>(
    "/workspaces/:workspaceId/environments",
    { schema: { params: workspaceParams, body: newEnvironmentBody } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      authorize(store, request, workspaceId, "environments:write");
      const environment = store.createEnvironment(workspaceId, request.body);
      return reply.code(201).send(environment);
    },
  );

  app.get<{ Params: WorkspaceParams }>(
    "/workspaces/:workspaceId/flags",
    { schema: { params: workspaceParams } },
    async (request) => {
      const { workspaceId } = request.params;
      authorize(store, request, workspaceId, "workspace:read");
      return { items: store.listFlags(workspaceId) };
    },
  );

  app.get<{ Params: FlagParams }>(
    "/workspaces/:workspaceId/flags/:flagKey",
    { schema: { params: flagParams } },
    async (request) => {
      const { workspaceId, flagKey } = request.params;
      authorize(store, request, workspaceId, "workspace:read");
      const flag = store.getFlag(workspaceId, flagKey);
      if (!flag) throw new ApiError(404, "NOT_FOUND", `Flag "${flagKey}" not found`);
      return flag;
    },
  );

  app.post<{ Params: WorkspaceParams; Body: NewFlag }>(
    "/workspaces/:workspaceId/flags",
    { schema: { params: workspaceParams, body: newFlagBody } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      authorize(store, request, workspaceId, "flags:write");
      const flag = store.createFlag(workspaceId, request.body);
      return reply.code(201).send(flag);
    },
  );

  app.patch<{ Params: FlagParams; Body: FlagPatch }>(
    "/workspaces/:workspaceId/flags/:flagKey",
    { schema: { params: flagParams, body: flagPatchBody } },
    async (request) => {
      const { workspaceId, flagKey } = request.params;
      authorize(store, request, workspaceId, "flags:write");
      const { description, defaultValue, archived } = request.body;
      if (description === undefined && defaultValue === undefined && archived === undefined) {
        throw new ApiError(400, "VALIDATION_FAILED", "Nothing to update");
      }
      return store.updateFlag(workspaceId, flagKey, { description, defaultValue, archived });
    },
  );
}
