import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_HEADER } from "../auth.js";
import { demoSeed } from "../seed.js";
import { buildServer } from "../server.js";
import { MemoryStore } from "../store.js";

type App = ReturnType<typeof buildServer>;

const fixedNow = () => new Date("2026-01-05T09:00:00.000Z");

function as(user: string) {
  return { [USER_HEADER]: user };
}

describe("workspace API", () => {
  let app: App;
  let store: MemoryStore;

  beforeEach(async () => {
    store = MemoryStore.fromSeed(demoSeed, fixedNow);
    app = buildServer({ store, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("authentication and membership", () => {
    it("rejects requests without a user", async () => {
      const res = await app.inject({ method: "GET", url: "/workspaces/storefront/flags" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    });

    it("hides workspaces the user does not belong to", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/workspaces/storefront/flags",
        headers: as("dave"),
      });
      expect(res.statusCode).toBe(404);
    });

    it("answers the same for a missing workspace and a foreign one", async () => {
      const missing = await app.inject({
        method: "GET",
        url: "/workspaces/does-not-exist/flags",
        headers: as("dave"),
      });
      const foreign = await app.inject({
        method: "GET",
        url: "/workspaces/storefront/flags",
        headers: as("dave"),
      });
      expect(missing.statusCode).toBe(foreign.statusCode);
      expect(missing.json()).toEqual(foreign.json());
    });
  });

  describe("workspace isolation", () => {
    it("lists only the caller's workspace flags", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/workspaces/payments/flags",
        headers: as("dave"),
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<{ workspaceId: string }>;
      expect(items).toHaveLength(1);
      expect(items.every((f) => f.workspaceId === "payments")).toBe(true);
    });

    it("does not let an owner of one workspace change another workspace's flag", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/workspaces/storefront/flags/new-checkout",
        headers: as("dave"),
        payload: { defaultValue: true },
      });
      expect(res.statusCode).toBe(404);
      expect(store.getFlag("storefront", "new-checkout")?.defaultValue).toBe(false);
    });

    it("does not let an owner of one workspace create flags in another", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces/storefront/flags",
        headers: as("dave"),
        payload: { key: "sneaky" },
      });
      expect(res.statusCode).toBe(404);
      expect(store.getFlag("storefront", "sneaky")).toBeUndefined();
    });

    it("keeps flags with the same key independent across workspaces", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/workspaces/payments/flags/new-checkout",
        headers: as("dave"),
        payload: { defaultValue: true },
      });
      expect(res.statusCode).toBe(200);
      expect(store.getFlag("payments", "new-checkout")?.defaultValue).toBe(true);
      expect(store.getFlag("storefront", "new-checkout")?.defaultValue).toBe(false);
    });
  });

  describe("roles", () => {
    it("lets an editor create a flag that starts off", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces/storefront/flags",
        headers: as("bob"),
        payload: { key: "express-shipping", description: "Show express shipping" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        workspaceId: "storefront",
        key: "express-shipping",
        type: "boolean",
        defaultValue: false,
        archived: false,
        createdAt: "2026-01-05T09:00:00.000Z",
      });
    });

    it("lets a viewer read but not write flags", async () => {
      const read = await app.inject({
        method: "GET",
        url: "/workspaces/storefront/flags/new-checkout",
        headers: as("carol"),
      });
      expect(read.statusCode).toBe(200);

      const write = await app.inject({
        method: "PATCH",
        url: "/workspaces/storefront/flags/new-checkout",
        headers: as("carol"),
        payload: { archived: true },
      });
      expect(write.statusCode).toBe(403);
      expect(write.json().error.code).toBe("FORBIDDEN");
      expect(store.getFlag("storefront", "new-checkout")?.archived).toBe(false);
    });

    it("lets only owners create environments", async () => {
      const byEditor = await app.inject({
        method: "POST",
        url: "/workspaces/storefront/environments",
        headers: as("bob"),
        payload: { key: "staging", name: "Staging" },
      });
      expect(byEditor.statusCode).toBe(403);

      const byOwner = await app.inject({
        method: "POST",
        url: "/workspaces/storefront/environments",
        headers: as("alice"),
        payload: { key: "staging", name: "Staging" },
      });
      expect(byOwner.statusCode).toBe(201);

      const list = await app.inject({
        method: "GET",
        url: "/workspaces/storefront/environments",
        headers: as("carol"),
      });
      const keys = (list.json().items as Array<{ key: string }>).map((e) => e.key);
      expect(keys).toEqual(["development", "production", "staging"]);
    });
  });

  describe("validation", () => {
    it("rejects duplicate flag keys within a workspace", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces/storefront/flags",
        headers: as("alice"),
        payload: { key: "new-checkout" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("CONFLICT");
    });

    it("rejects flag keys that are not lowercase kebab case", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces/storefront/flags",
        headers: as("alice"),
        payload: { key: "New Checkout" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    });

    it("rejects a non-boolean default value", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces/storefront/flags",
        headers: as("alice"),
        payload: { key: "typed", defaultValue: "yes" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an empty update", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/workspaces/storefront/flags/new-checkout",
        headers: as("alice"),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for an unknown flag", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/workspaces/storefront/flags/missing",
        headers: as("alice"),
        payload: { archived: true },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
