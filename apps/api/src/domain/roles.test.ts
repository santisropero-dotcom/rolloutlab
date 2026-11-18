import { describe, expect, it } from "vitest";
import { can, ROLES, type Permission, type Role } from "./roles.js";

describe("role permissions", () => {
  const expected: Record<Role, Record<Permission, boolean>> = {
    owner: { "workspace:read": true, "flags:write": true, "environments:write": true },
    editor: { "workspace:read": true, "flags:write": true, "environments:write": false },
    viewer: { "workspace:read": true, "flags:write": false, "environments:write": false },
  };

  for (const role of ROLES) {
    for (const [permission, allowed] of Object.entries(expected[role])) {
      it(`${role} ${allowed ? "can" : "cannot"} ${permission}`, () => {
        expect(can(role, permission as Permission)).toBe(allowed);
      });
    }
  }
});
