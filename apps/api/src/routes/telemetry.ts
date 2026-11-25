import type { FastifyInstance } from "fastify";
import { MAX_SUBJECT_KEY_LENGTH } from "@rolloutlab/evaluator";
import { cohortMetricsProblems, type CohortMetrics } from "@rolloutlab/metrics";
import { authorize } from "../auth.js";
import {
  MAX_EVENT_ID_LENGTH,
  MAX_EVENTS_PER_BATCH,
  OUTCOMES,
  type TelemetryEventInput,
} from "../domain/telemetry.js";
import { ApiError } from "../errors.js";
import type { MemoryStore } from "../store.js";

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

const telemetryParams = {
  type: "object",
  required: ["workspaceId", "flagKey", "environmentKey"],
  properties: {
    workspaceId: { type: "string", minLength: 1 },
    flagKey: { type: "string", minLength: 1 },
    environmentKey: { type: "string", minLength: 1 },
  },
} as const;

// Shape only; the content rules live in `eventProblems` so a bad event is
// reported on its own instead of failing the whole batch.
const ingestBody = {
  type: "object",
  required: ["events"],
  additionalProperties: false,
  properties: {
    events: {
      type: "array",
      minItems: 1,
      maxItems: MAX_EVENTS_PER_BATCH,
      items: {
        type: "object",
        required: ["eventId", "subjectKey", "value", "outcome", "occurredAt"],
        additionalProperties: false,
        properties: {
          eventId: { type: "string", maxLength: MAX_EVENT_ID_LENGTH * 2 },
          subjectKey: { type: "string", maxLength: MAX_SUBJECT_KEY_LENGTH * 2 },
          value: { type: "boolean" },
          outcome: { type: "string", enum: [...OUTCOMES] },
          latencyMs: { type: "number" },
          occurredAt: { type: "string", maxLength: 64 },
        },
      },
    },
  },
} as const;

const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    after: { type: "string", maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
  },
} as const;

interface TelemetryParams {
  workspaceId: string;
  flagKey: string;
  environmentKey: string;
}

export function registerTelemetryRoutes(app: FastifyInstance, store: MemoryStore): void {
  const path =
    "/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/telemetry/events";

  app.post<{ Params: TelemetryParams; Body: { events: TelemetryEventInput[] } }>(
    path,
    { schema: { params: telemetryParams, body: ingestBody } },
    async (request, reply) => {
      const { workspaceId, flagKey, environmentKey } = request.params;
      authorize(store, request, workspaceId, "telemetry:write");
      const result = store.ingestTelemetry(
        workspaceId,
        flagKey,
        environmentKey,
        request.body.events,
      );
      // 207 tells a sender to read `rejected`; everything else was stored or
      // was already there.
      return reply.code(result.rejected.length > 0 ? 207 : 200).send(result);
    },
  );

  app.get<{ Params: TelemetryParams; Querystring: { after?: string; limit: number } }>(
    path,
    { schema: { params: telemetryParams, querystring: listQuery } },
    async (request) => {
      const { workspaceId, flagKey, environmentKey } = request.params;
      authorize(store, request, workspaceId, "workspace:read");
      return store.listTelemetry(workspaceId, flagKey, environmentKey, request.query);
    },
  );

  const metricsPath =
    "/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/telemetry/metrics";

  // Written by the metrics worker. The body is checked by
  // `cohortMetricsProblems` so a malformed or inconsistent report never lands.
  app.put<{ Params: TelemetryParams; Body: unknown }>(
    metricsPath,
    // 2,000 windows of both cohorts stay well under 2 MiB.
    { schema: { params: telemetryParams }, bodyLimit: 2 * 1024 * 1024 },
    async (request) => {
      const { workspaceId, flagKey, environmentKey } = request.params;
      const membership = authorize(store, request, workspaceId, "telemetry:write");
      const problems = cohortMetricsProblems(request.body);
      if (problems.length > 0) {
        throw new ApiError(400, "VALIDATION_FAILED", problems.join("; "));
      }
      return store.putCohortMetrics(
        workspaceId,
        flagKey,
        environmentKey,
        request.body as CohortMetrics,
        membership.userId,
      );
    },
  );

  app.get<{ Params: TelemetryParams }>(
    metricsPath,
    { schema: { params: telemetryParams } },
    async (request) => {
      const { workspaceId, flagKey, environmentKey } = request.params;
      authorize(store, request, workspaceId, "workspace:read");
      return store.getCohortMetrics(workspaceId, flagKey, environmentKey);
    },
  );
}
