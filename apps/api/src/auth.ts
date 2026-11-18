import type { FastifyRequest } from "fastify";
import { can, type Permission } from "./domain/roles.js";
import type { Membership } from "./domain/types.js";
import { ApiError } from "./errors.js";
import type { MemoryStore } from "./store.js";

/**
 * Local development identity: the caller names a synthetic user in this
 * header. It stands in for real sign-in, which is out of scope for the demo.
 */
export const USER_HEADER = "x-rolloutlab-user";

function userIdFrom(request: FastifyRequest): string | undefined {
  const value = request.headers[USER_HEADER];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Checks that the caller belongs to the workspace and holds the permission.
 *
 * A caller outside the workspace gets 404 rather than 403, so the API does not
 * reveal which workspaces exist.
 */
export function authorize(
  store: MemoryStore,
  request: FastifyRequest,
  workspaceId: string,
  permission: Permission,
): Membership {
  const userId = userIdFrom(request);
  if (!userId) {
    throw new ApiError(401, "UNAUTHENTICATED", `Missing ${USER_HEADER} header`);
  }
  const membership = store.getMembership(workspaceId, userId);
  if (!membership) {
    throw new ApiError(404, "NOT_FOUND", "Workspace not found");
  }
  if (!can(membership.role, permission)) {
    throw new ApiError(403, "FORBIDDEN", `Role "${membership.role}" cannot ${permission}`);
  }
  return membership;
}
