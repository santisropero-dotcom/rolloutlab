import type { Role } from "./roles.js";

export interface Workspace {
  id: string;
  name: string;
}

export interface Membership {
  workspaceId: string;
  userId: string;
  role: Role;
}

export interface Environment {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  createdAt: string;
}

export interface Flag {
  id: string;
  workspaceId: string;
  key: string;
  description: string;
  type: "boolean";
  defaultValue: boolean;
  /** Mixed into cohort bucketing; changing it reshuffles percentage cohorts. */
  salt: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewEnvironment {
  key: string;
  name: string;
}

export interface NewFlag {
  key: string;
  description?: string;
  defaultValue?: boolean;
}

export interface FlagPatch {
  description?: string;
  defaultValue?: boolean;
  salt?: string;
  archived?: boolean;
}
