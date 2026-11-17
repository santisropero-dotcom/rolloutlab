import Fastify from "fastify";

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok", service: "api" }));

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
