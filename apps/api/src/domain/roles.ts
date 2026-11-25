/**
 * Workspace roles and what each one may do.
 *
 * Roles are scoped to a single workspace: being an owner in one workspace
 * grants nothing in another.
 */

export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "workspace:read"
  | "flags:write"
  | "environments:write"
  | "telemetry:write";

const grants: Readonly<Record<Role, readonly Permission[]>> = {
  owner: ["workspace:read", "flags:write", "environments:write", "telemetry:write"],
  editor: ["workspace:read", "flags:write", "telemetry:write"],
  viewer: ["workspace:read"],
};

export function can(role: Role, permission: Permission): boolean {
  return grants[role].includes(permission);
}
