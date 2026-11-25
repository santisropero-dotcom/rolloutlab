import Fastify, { type FastifyError } from "fastify";
import { ApiError } from "./errors.js";
import { registerEvaluationRoutes } from "./routes/evaluation.js";
import { registerRolloutRoutes } from "./routes/rollouts.js";
import { registerTargetingRoutes } from "./routes/targeting.js";
import { registerTelemetryRoutes } from "./routes/telemetry.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { createDemoStore } from "./seed.js";
import type { MemoryStore } from "./store.js";

export interface ServerOptions {
  store?: MemoryStore;
  logger?: boolean;
}

export function buildServer(options: ServerOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const store = options.store ?? createDemoStore();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    const fastifyError = error as FastifyError;
    if (fastifyError.validation) {
      return reply
        .code(400)
        .send({ error: { code: "VALIDATION_FAILED", message: fastifyError.message } });
    }
    // Client errors raised by Fastify itself, e.g. a body that is not valid JSON.
    if (fastifyError.statusCode !== undefined && fastifyError.statusCode < 500) {
      return reply
        .code(fastifyError.statusCode)
        .send({ error: { code: "BAD_REQUEST", message: fastifyError.message } });
    }
    request.log.error(error);
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  app.get("/health", async () => ({ status: "ok", service: "api" }));

  registerWorkspaceRoutes(app, store);
  registerTargetingRoutes(app, store);
  registerEvaluationRoutes(app, store);
  registerRolloutRoutes(app, store);
  registerTelemetryRoutes(app, store);

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const port = Number(process.env.API_PORT ?? 4000);
  const app = buildServer();
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
