import { MemoryStore, type StoreSeed } from "./store.js";

/**
 * Synthetic demo data: two workspaces with separate teams, so workspace
 * isolation can be tried locally without any real accounts.
 */
export const demoSeed: StoreSeed = {
  workspaces: [
    { id: "storefront", name: "Storefront" },
    { id: "payments", name: "Payments" },
  ],
  memberships: [
    { workspaceId: "storefront", userId: "alice", role: "owner" },
    { workspaceId: "storefront", userId: "bob", role: "editor" },
    { workspaceId: "storefront", userId: "carol", role: "viewer" },
    { workspaceId: "payments", userId: "dave", role: "owner" },
  ],
  environments: [
    { workspaceId: "storefront", key: "development", name: "Development" },
    { workspaceId: "storefront", key: "production", name: "Production" },
    { workspaceId: "payments", key: "production", name: "Production" },
  ],
  flags: [
    {
      workspaceId: "storefront",
      key: "new-checkout",
      description: "One-step checkout that shows the amount to pay on the button.",
      defaultValue: false,
    },
    {
      workspaceId: "payments",
      key: "new-checkout",
      description: "Payments team flag with the same key, kept separate.",
      defaultValue: false,
    },
  ],
};

export function createDemoStore(): MemoryStore {
  return MemoryStore.fromSeed(demoSeed);
}
