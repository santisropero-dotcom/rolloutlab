// Metrics aggregation worker. Queue consumers are added with the telemetry pipeline.
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export function describeWorker() {
  return { service: "worker", redisUrl };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  console.log("worker ready", describeWorker());
}
