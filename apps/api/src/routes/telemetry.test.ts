import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_HEADER } from "../auth.js";
import { syntheticCheckoutTelemetry } from "../domain/telemetry-fixture.js";
import type { TelemetryEvent, TelemetryEventInput } from "../domain/telemetry.js";
import { demoSeed } from "../seed.js";
import { buildServer } from "../server.js";
import { MemoryStore } from "../store.js";

type App = ReturnType<typeof buildServer>;

const fixedNow = () => new Date("2026-01-12T10:00:00.000Z");
const eventsUrl = (workspace: string, flag: string, environment: string) =>
  `/workspaces/${workspace}/flags/${flag}/environments/${environment}/telemetry/events`;
const production = eventsUrl("storefront", "new-checkout", "production");

function as(user: string) {
  return { [USER_HEADER]: user };
}

function event(id: string, overrides: Partial<TelemetryEventInput> = {}): TelemetryEventInput {
  return {
    eventId: id,
    subjectKey: "synthetic-0001",
    value: true,
    outcome: "success",
    latencyMs: 100,
    occurredAt: "2026-01-12T09:30:00.000Z",
    ...overrides,
  };
}

const fixture = syntheticCheckoutTelemetry({
  flagKey: "new-checkout",
  salt: "new-checkout",
  percentage: 10,
  start: "2026-01-12T09:00:00.000Z",
  treatmentErrorRate: 0.06,
  controlErrorRate: 0.01,
});

describe("telemetry API", () => {
  let app: App;

  beforeEach(async () => {
    app = buildServer({ store: MemoryStore.fromSeed(demoSeed, fixedNow), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function send(events: TelemetryEventInput[], user = "bob", url = production) {
    return app.inject({ method: "POST", url, headers: as(user), payload: { events } });
  }

  async function listAll(user = "carol", url = production, limit = 500) {
    const items: TelemetryEvent[] = [];
    let after: string | null = null;
    do {
      const query: string = `?limit=${limit}${after ? `&after=${after}` : ""}`;
      const res = await app.inject({ method: "GET", url: `${url}${query}`, headers: as(user) });
      expect(res.statusCode).toBe(200);
      const page = res.json();
      items.push(...page.items);
      after = page.nextCursor;
    } while (after);
    return items;
  }

  it("stores a batch and lists it oldest first", async () => {
    const res = await send([
      event("b", { occurredAt: "2026-01-12T09:40:00.000Z" }),
      event("a", { occurredAt: "2026-01-12T09:20:00+00:00", outcome: "error" }),
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 2, accepted: 2, duplicates: 0, rejected: [] });

    const list = await app.inject({ method: "GET", url: production, headers: as("carol") });
    expect(list.json()).toMatchObject({ total: 2, nextCursor: null });
    expect(list.json().items).toEqual([
      expect.objectContaining({
        eventId: "a",
        outcome: "error",
        occurredAt: "2026-01-12T09:20:00.000Z",
        receivedAt: "2026-01-12T10:00:00.000Z",
        workspaceId: "storefront",
        flagKey: "new-checkout",
        environmentKey: "production",
      }),
      expect.objectContaining({ eventId: "b" }),
    ]);
  });

  it("ignores a resent event with the same content", async () => {
    await send([event("a")]);
    const again = await send([event("a"), event("b")]);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ received: 2, accepted: 1, duplicates: 1, rejected: [] });
    expect((await listAll()).map((e) => e.eventId)).toEqual(["a", "b"]);
  });

  it("treats the same instant in another time zone as the same content", async () => {
    await send([event("a")]);
    const again = await send([event("a", { occurredAt: "2026-01-12T10:30:00+01:00" })]);
    expect(again.json()).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it("counts a repeat inside one batch once", async () => {
    const res = await send([event("a"), event("a")]);
    expect(res.json()).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it("keeps the first version when an id comes back with different content", async () => {
    await send([event("a")]);
    const res = await send([event("a", { outcome: "error" })]);
    expect(res.statusCode).toBe(207);
    expect(res.json().rejected).toEqual([
      {
        index: 0,
        eventId: "a",
        code: "CONFLICTING_DUPLICATE",
        message: 'Event "a" was already recorded with different content',
      },
    ]);
    expect((await listAll())[0]).toMatchObject({ eventId: "a", outcome: "success" });
  });

  it("stores the valid events of a batch and reports the invalid ones by position", async () => {
    const res = await send([
      event("ok-1"),
      event("bad time", { occurredAt: "yesterday" }),
      event("future", { occurredAt: "2026-01-12T11:00:00.000Z" }),
      event("ok-2"),
    ]);
    expect(res.statusCode).toBe(207);
    const body = res.json();
    expect(body).toMatchObject({ received: 4, accepted: 2, duplicates: 0 });
    expect(body.rejected.map((r: { index: number; code: string }) => [r.index, r.code])).toEqual([
      [1, "INVALID_EVENT"],
      [2, "INVALID_EVENT"],
    ]);
    expect(body.rejected[0].message).toContain("eventId");
    expect(body.rejected[0].message).toContain("occurredAt");
  });

  it("rejects malformed batches as a whole", async () => {
    const cases: unknown[] = [
      {},
      { events: [] },
      { events: [{ ...event("a"), outcome: "timeout" }] },
      { events: [{ ...event("a"), value: "yes" }] },
      { events: Array.from({ length: 1001 }, (_, i) => event(`e-${i}`)) },
    ];
    for (const payload of cases) {
      const res = await app.inject({
        method: "POST",
        url: production,
        headers: as("bob"),
        payload: payload as object,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    }
    expect(await listAll()).toEqual([]);
  });

  it("replaying the synthetic fixture stores exactly the same events", async () => {
    const first = [];
    for (let i = 0; i < fixture.length; i += 1000) {
      first.push((await send(fixture.slice(i, i + 1000))).json());
    }
    expect(first.reduce((n, r) => n + r.accepted, 0)).toBe(3000);
    const before = await listAll();

    for (let i = 0; i < fixture.length; i += 1000) {
      const res = await send(fixture.slice(i, i + 1000));
      expect(res.json()).toMatchObject({ accepted: 0, duplicates: 1000, rejected: [] });
    }
    // Sending the batches in a different order changes nothing either.
    for (let i = fixture.length - 1000; i >= 0; i -= 1000) {
      expect((await send(fixture.slice(i, i + 1000))).json().accepted).toBe(0);
    }
    const after = await listAll();
    expect(after).toEqual(before);
    expect(after).toHaveLength(3000);
  });

  it("pages with a cursor without repeating or skipping events", async () => {
    await send(fixture.slice(0, 250));
    const pages = await listAll("carol", production, 40);
    expect(pages).toHaveLength(250);
    expect(new Set(pages.map((e) => e.eventId)).size).toBe(250);
    const sorted = [...pages].sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? a.eventId.localeCompare(b.eventId)
        : a.occurredAt.localeCompare(b.occurredAt),
    );
    expect(pages).toEqual(sorted);
  });

  it("rejects a cursor it did not issue", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${production}?after=not-a-cursor`,
      headers: as("carol"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("keeps telemetry per environment and per workspace", async () => {
    await send([event("a")]);
    expect(await listAll("carol", eventsUrl("storefront", "new-checkout", "development"))).toEqual(
      [],
    );
    expect(await listAll("dave", eventsUrl("payments", "new-checkout", "production"))).toEqual([]);
    // The same event id in another environment is a separate event.
    const dev = await send([event("a")], "bob", eventsUrl("storefront", "new-checkout", "development"));
    expect(dev.json()).toMatchObject({ accepted: 1, duplicates: 0 });
  });

  it("checks roles and membership", async () => {
    expect((await send([event("a")], "alice")).statusCode).toBe(200);
    const viewer = await send([event("b")], "carol");
    expect(viewer.statusCode).toBe(403);
    const outsider = await send([event("c")], "dave");
    expect(outsider.statusCode).toBe(404);
    const anonymous = await app.inject({
      method: "POST",
      url: production,
      payload: { events: [event("d")] },
    });
    expect(anonymous.statusCode).toBe(401);
    const read = await app.inject({ method: "GET", url: production, headers: as("dave") });
    expect(read.statusCode).toBe(404);
    expect((await listAll()).map((e) => e.eventId)).toEqual(["a"]);
  });

  it("answers 404 for an unknown flag or environment", async () => {
    expect((await send([event("a")], "bob", eventsUrl("storefront", "nope", "production"))).statusCode).toBe(404);
    expect((await send([event("a")], "bob", eventsUrl("storefront", "new-checkout", "staging"))).statusCode).toBe(404);
  });

  it("still accepts telemetry for an archived flag", async () => {
    await app.inject({
      method: "PATCH",
      url: "/workspaces/storefront/flags/new-checkout",
      headers: as("bob"),
      payload: { archived: true },
    });
    expect((await send([event("a")])).statusCode).toBe(200);
  });
});
