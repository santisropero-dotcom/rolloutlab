import type {
  Environment,
  Flag,
  FlagPatch,
  Membership,
  NewEnvironment,
  NewFlag,
  Workspace,
} from "./domain/types.js";
import type { FlagTargeting, TargetingRule } from "./domain/targeting.js";
import { ApiError } from "./errors.js";

export interface StoreSeed {
  workspaces: Workspace[];
  memberships: Membership[];
  environments?: Array<NewEnvironment & { workspaceId: string }>;
  flags?: Array<NewFlag & { workspaceId: string }>;
  targeting?: Array<Omit<FlagTargeting, "updatedAt">>;
}

/**
 * In-memory store used until the PostgreSQL schema lands.
 *
 * Every read and write takes a workspace id, and lookups never fall back to
 * another workspace, so a flag key that exists in two workspaces resolves to
 * two independent records.
 */
export class MemoryStore {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly memberships: Membership[] = [];
  private readonly environments: Environment[] = [];
  private readonly flags: Flag[] = [];
  /** Rules per flag and environment, keyed by `workspace/flag/environment`. */
  private readonly targeting = new Map<string, { rules: TargetingRule[]; updatedAt: string }>();
  private sequence = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  static fromSeed(seed: StoreSeed, now?: () => Date): MemoryStore {
    const store = new MemoryStore(now);
    for (const workspace of seed.workspaces) store.addWorkspace(workspace);
    for (const membership of seed.memberships) store.addMembership(membership);
    for (const { workspaceId, ...input } of seed.environments ?? []) {
      store.createEnvironment(workspaceId, input);
    }
    for (const { workspaceId, ...input } of seed.flags ?? []) {
      store.createFlag(workspaceId, input);
    }
    for (const { workspaceId, flagKey, environmentKey, rules } of seed.targeting ?? []) {
      store.setTargeting(workspaceId, flagKey, environmentKey, rules);
    }
    return store;
  }

  addWorkspace(workspace: Workspace): void {
    if (this.workspaces.has(workspace.id)) {
      throw new Error(`Workspace ${workspace.id} already exists`);
    }
    this.workspaces.set(workspace.id, { ...workspace });
  }

  addMembership(membership: Membership): void {
    if (!this.workspaces.has(membership.workspaceId)) {
      throw new Error(`Workspace ${membership.workspaceId} does not exist`);
    }
    if (this.getMembership(membership.workspaceId, membership.userId)) {
      throw new Error(`User ${membership.userId} is already a member of ${membership.workspaceId}`);
    }
    this.memberships.push({ ...membership });
  }

  getWorkspace(workspaceId: string): Workspace | undefined {
    const workspace = this.workspaces.get(workspaceId);
    return workspace && { ...workspace };
  }

  getMembership(workspaceId: string, userId: string): Membership | undefined {
    const membership = this.memberships.find(
      (m) => m.workspaceId === workspaceId && m.userId === userId,
    );
    return membership && { ...membership };
  }

  listEnvironments(workspaceId: string): Environment[] {
    return this.environments
      .filter((e) => e.workspaceId === workspaceId)
      .map((e) => ({ ...e }));
  }

  createEnvironment(workspaceId: string, input: NewEnvironment): Environment {
    this.requireWorkspace(workspaceId);
    if (this.environments.some((e) => e.workspaceId === workspaceId && e.key === input.key)) {
      throw new ApiError(409, "CONFLICT", `Environment "${input.key}" already exists`);
    }
    const environment: Environment = {
      id: this.nextId("env"),
      workspaceId,
      key: input.key,
      name: input.name,
      createdAt: this.now().toISOString(),
    };
    this.environments.push(environment);
    return { ...environment };
  }

  listFlags(workspaceId: string): Flag[] {
    return this.flags.filter((f) => f.workspaceId === workspaceId).map((f) => ({ ...f }));
  }

  getFlag(workspaceId: string, key: string): Flag | undefined {
    const flag = this.findFlag(workspaceId, key);
    return flag && { ...flag };
  }

  createFlag(workspaceId: string, input: NewFlag): Flag {
    this.requireWorkspace(workspaceId);
    if (this.findFlag(workspaceId, input.key)) {
      throw new ApiError(409, "CONFLICT", `Flag "${input.key}" already exists`);
    }
    const timestamp = this.now().toISOString();
    const flag: Flag = {
      id: this.nextId("flag"),
      workspaceId,
      key: input.key,
      description: input.description ?? "",
      type: "boolean",
      // New flags are off unless the caller says otherwise.
      defaultValue: input.defaultValue ?? false,
      // The key is a stable starting salt; owners can rotate it later.
      salt: input.key,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.flags.push(flag);
    return { ...flag };
  }

  updateFlag(workspaceId: string, key: string, patch: FlagPatch): Flag {
    const flag = this.findFlag(workspaceId, key);
    if (!flag) throw new ApiError(404, "NOT_FOUND", `Flag "${key}" not found`);
    if (patch.description !== undefined) flag.description = patch.description;
    if (patch.defaultValue !== undefined) flag.defaultValue = patch.defaultValue;
    if (patch.salt !== undefined) flag.salt = patch.salt;
    if (patch.archived !== undefined) flag.archived = patch.archived;
    flag.updatedAt = this.now().toISOString();
    return { ...flag };
  }

  /**
   * Targeting for one flag in one environment. A flag with no saved rules has
   * an empty list, so every identity gets the flag's default.
   */
  getTargeting(workspaceId: string, flagKey: string, environmentKey: string): FlagTargeting {
    this.requireFlagAndEnvironment(workspaceId, flagKey, environmentKey);
    const saved = this.targeting.get(targetingKey(workspaceId, flagKey, environmentKey));
    return {
      workspaceId,
      flagKey,
      environmentKey,
      rules: cloneRules(saved?.rules ?? []),
      updatedAt: saved?.updatedAt ?? null,
    };
  }

  /** Replaces the whole ordered rule list, so reordering is a single write. */
  setTargeting(
    workspaceId: string,
    flagKey: string,
    environmentKey: string,
    rules: readonly TargetingRule[],
  ): FlagTargeting {
    const flag = this.requireFlagAndEnvironment(workspaceId, flagKey, environmentKey);
    if (flag.archived) {
      throw new ApiError(409, "CONFLICT", `Flag "${flagKey}" is archived`);
    }
    const updatedAt = this.now().toISOString();
    this.targeting.set(targetingKey(workspaceId, flagKey, environmentKey), {
      rules: cloneRules(rules),
      updatedAt,
    });
    return { workspaceId, flagKey, environmentKey, rules: cloneRules(rules), updatedAt };
  }

  private requireFlagAndEnvironment(
    workspaceId: string,
    flagKey: string,
    environmentKey: string,
  ): Flag {
    const flag = this.findFlag(workspaceId, flagKey);
    if (!flag) throw new ApiError(404, "NOT_FOUND", `Flag "${flagKey}" not found`);
    const environment = this.environments.find(
      (e) => e.workspaceId === workspaceId && e.key === environmentKey,
    );
    if (!environment) {
      throw new ApiError(404, "NOT_FOUND", `Environment "${environmentKey}" not found`);
    }
    return flag;
  }

  private findFlag(workspaceId: string, key: string): Flag | undefined {
    return this.flags.find((f) => f.workspaceId === workspaceId && f.key === key);
  }

  private requireWorkspace(workspaceId: string): void {
    if (!this.workspaces.has(workspaceId)) {
      throw new ApiError(404, "NOT_FOUND", "Workspace not found");
    }
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }
}

function targetingKey(workspaceId: string, flagKey: string, environmentKey: string): string {
  return `${workspaceId}/${flagKey}/${environmentKey}`;
}

function cloneRules(rules: readonly TargetingRule[]): TargetingRule[] {
  return rules.map((rule) => ({
    ...rule,
    conditions: rule.conditions.map((c) => ({ ...c, values: [...c.values] })),
  }));
}
