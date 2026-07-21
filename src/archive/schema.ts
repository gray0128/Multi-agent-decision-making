import { isAbsolute } from "node:path";
import { ADAPTER_IDS } from "../adapters/config.js";
import { MadError } from "../core/errors.js";
import { assertDeliberationId } from "../core/paths.js";
import { DELIBERATION_MODES, DELIBERATION_STATUSES, INTERACTION_POLICIES } from "../core/types.js";
import type {
  DeliberationAgent,
  DeliberationManifest,
  DeliberationMode,
  DeliberationPlan,
  InvocationConfigSnapshot,
  InvocationPresetRef,
  ResourceLimits,
} from "../core/types.js";
import type { ArchiveEvent, DeliberationState } from "./store.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MadError("EXECUTION", `${path} 必须是对象`);
  }
  return value as JsonObject;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new MadError("EXECUTION", `${path} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new MadError("EXECUTION", `${path} 必须是布尔值`);
  return value;
}

function integer(value: unknown, path: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new MadError("EXECUTION", `${path} 必须是大于等于 ${minimum} 的整数`);
  }
  return value as number;
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new MadError("EXECUTION", `${path} 必须是 ${allowed.join("、")} 之一`);
  }
  return value as T;
}

function invocation(value: unknown, path: string): InvocationPresetRef {
  const raw = object(value, path);
  return { cli: string(raw.cli, `${path}.cli`), preset: string(raw.preset, `${path}.preset`) };
}

function limits(value: unknown, path: string): ResourceLimits {
  const raw = object(value, path);
  return {
    maxParticipants: integer(raw.maxParticipants, `${path}.maxParticipants`),
    maxCalls: integer(raw.maxCalls, `${path}.maxCalls`),
    maxDiscussionWindows: integer(raw.maxDiscussionWindows, `${path}.maxDiscussionWindows`),
    timeoutSeconds: integer(raw.timeoutSeconds, `${path}.timeoutSeconds`),
    contextBudget: integer(raw.contextBudget, `${path}.contextBudget`),
    ...(raw.globalConcurrency === undefined
      ? {}
      : { globalConcurrency: integer(raw.globalConcurrency, `${path}.globalConcurrency`) }),
  };
}

function plan(value: unknown, mode: DeliberationMode, path: string): DeliberationPlan {
  const raw = object(value, path);
  if (!Array.isArray(raw.participants) || raw.participants.length < 2) {
    throw new MadError("EXECUTION", `${path}.participants 至少需要两个参与者`);
  }
  const participants: DeliberationAgent[] = raw.participants.map((entry, index) => {
    const participant = object(entry, `${path}.participants[${index}]`);
    return {
      id: string(participant.id, `${path}.participants[${index}].id`),
      invocation: invocation(participant.invocation, `${path}.participants[${index}].invocation`),
      role: string(participant.role, `${path}.participants[${index}].role`),
    };
  });
  const ids = participants.map((participant) => participant.id);
  if (new Set(ids).size !== ids.length) throw new MadError("EXECUTION", `${path}.participants 包含重复 ID`);
  const reportAgentId = string(raw.reportAgentId, `${path}.reportAgentId`);
  if (!ids.includes(reportAgentId)) throw new MadError("EXECUTION", `${path}.reportAgentId 必须引用参与者`);
  const moderatorAgentId = raw.moderatorAgentId === undefined
    ? undefined
    : string(raw.moderatorAgentId, `${path}.moderatorAgentId`);
  if (mode === "free" && (!moderatorAgentId || !ids.includes(moderatorAgentId))) {
    throw new MadError("EXECUTION", `${path}.moderatorAgentId 必须引用参与者`);
  }
  return {
    organizer: invocation(raw.organizer, `${path}.organizer`),
    participants,
    reportAgentId,
    ...(moderatorAgentId ? { moderatorAgentId } : {}),
    limits: limits(raw.limits, `${path}.limits`),
  };
}

function registrySnapshot(value: unknown, path: string): InvocationConfigSnapshot[] {
  if (!Array.isArray(value)) throw new MadError("EXECUTION", `${path} 必须是数组`);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const raw = object(entry, itemPath);
    const options = object(raw.options, `${itemPath}.options`);
    return {
      cli: string(raw.cli, `${itemPath}.cli`),
      preset: string(raw.preset, `${itemPath}.preset`),
      adapter: enumeration(raw.adapter, ADAPTER_IDS, `${itemPath}.adapter`),
      executable: string(raw.executable, `${itemPath}.executable`),
      timeoutSeconds: integer(raw.timeoutSeconds, `${itemPath}.timeoutSeconds`),
      maxConcurrency: integer(raw.maxConcurrency, `${itemPath}.maxConcurrency`),
      model: string(raw.model, `${itemPath}.model`),
      contextBudget: integer(raw.contextBudget, `${itemPath}.contextBudget`),
      options: options as InvocationConfigSnapshot["options"],
    };
  });
}

export function parseDeliberationManifest(value: unknown): DeliberationManifest {
  const raw = object(value, "manifest");
  const version = raw.schema_version ?? raw.schemaVersion;
  if (version !== 1) throw new MadError("EXECUTION", "manifest.schema_version 必须是 1");
  const id = string(raw.id, "manifest.id");
  assertDeliberationId(id);
  const mode = enumeration(raw.mode, DELIBERATION_MODES, "manifest.mode");
  const parsed: DeliberationManifest = {
    schemaVersion: 1,
    id,
    createdAt: string(raw.createdAt, "manifest.createdAt"),
    question: string(raw.question, "manifest.question"),
    mode,
    interaction: enumeration(raw.interaction, INTERACTION_POLICIES, "manifest.interaction"),
    ...(raw.plan === undefined ? {} : { plan: plan(raw.plan, mode, "manifest.plan") }),
    ...(raw.registrySnapshot === undefined ? {} : { registrySnapshot: registrySnapshot(raw.registrySnapshot, "manifest.registrySnapshot") }),
  };
  if (raw.workspace !== undefined) {
    const workspace = object(raw.workspace, "manifest.workspace");
    const path = string(workspace.path, "manifest.workspace.path");
    if (!isAbsolute(path)) throw new MadError("EXECUTION", "manifest.workspace.path 必须是绝对路径");
    Object.assign(parsed, {
      workspace: {
        path,
        mode: enumeration(workspace.mode, ["direct-read-only"] as const, "manifest.workspace.mode"),
      },
    });
  }
  if (raw.planConfirmation !== undefined) {
    Object.assign(parsed, {
      planConfirmation: enumeration(
        raw.planConfirmation,
        ["interactive", "auto-first-valid"] as const,
        "manifest.planConfirmation",
      ),
    });
  }
  if (raw.planning !== undefined) {
    const planning = object(raw.planning, "manifest.planning");
    Object.assign(parsed, {
      planning: {
        organizer: invocation(planning.organizer, "manifest.planning.organizer"),
        limits: limits(planning.limits, "manifest.planning.limits"),
        autoConfirmPlan: boolean(planning.autoConfirmPlan, "manifest.planning.autoConfirmPlan"),
        allowRegeneration: boolean(planning.allowRegeneration, "manifest.planning.allowRegeneration"),
        projectMode: boolean(planning.projectMode, "manifest.planning.projectMode"),
        generation: integer(planning.generation, "manifest.planning.generation", 0),
        ...(planning.candidatePlan === undefined
          ? {}
          : { candidatePlan: plan(planning.candidatePlan, mode, "manifest.planning.candidatePlan") }),
      },
    });
  }
  return parsed;
}

function record(value: unknown, path: string): Record<string, unknown> {
  return object(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new MadError("EXECUTION", `${path} 必须是字符串数组`);
  }
  return value;
}

function pendingCheckpoint(value: unknown): NonNullable<DeliberationState["pendingCheckpoint"]> {
  const raw = object(value, "state.pendingCheckpoint");
  return {
    key: string(raw.key, "state.pendingCheckpoint.key"),
    checkpointId: string(raw.checkpointId, "state.pendingCheckpoint.checkpointId"),
    kind: string(raw.kind, "state.pendingCheckpoint.kind"),
    summary: string(raw.summary, "state.pendingCheckpoint.summary", true),
    actions: stringArray(raw.actions, "state.pendingCheckpoint.actions"),
  };
}

function checkpointDecisions(value: unknown): DeliberationState["checkpointDecisions"] {
  const raw = record(value, "state.checkpointDecisions");
  return Object.fromEntries(Object.entries(raw).map(([key, entry]) => {
    const decision = object(entry, `state.checkpointDecisions.${key}`);
    return [key, {
      action: string(decision.action, `state.checkpointDecisions.${key}.action`),
      guidance: string(decision.guidance, `state.checkpointDecisions.${key}.guidance`, true),
      at: string(decision.at, `state.checkpointDecisions.${key}.at`),
    }];
  }));
}

export function parseDeliberationState(value: unknown): DeliberationState {
  const raw = object(value, "state");
  const version = raw.schema_version ?? raw.schemaVersion;
  if (version !== 1) throw new MadError("EXECUTION", "state.schema_version 必须是 1");
  if (!Array.isArray(raw.guidance) || raw.guidance.some((entry) => typeof entry !== "string")) {
    throw new MadError("EXECUTION", "state.guidance 必须是字符串数组");
  }
  const parsedCheckpointDecisions = raw.checkpointDecisions === undefined
    ? {}
    : checkpointDecisions(raw.checkpointDecisions);
  return {
    schemaVersion: 1,
    status: enumeration(raw.status, DELIBERATION_STATUSES, "state.status"),
    updatedAt: string(raw.updatedAt, "state.updatedAt"),
    callAttempts: integer(raw.callAttempts, "state.callAttempts", 0),
    guidance: raw.guidance,
    pendingInvocations: record(raw.pendingInvocations, "state.pendingInvocations") as DeliberationState["pendingInvocations"],
    completedInvocations: record(raw.completedInvocations, "state.completedInvocations") as DeliberationState["completedInvocations"],
    checkpointDecisions: parsedCheckpointDecisions,
    ...(raw.pendingCheckpoint === undefined
      ? {}
      : { pendingCheckpoint: pendingCheckpoint(raw.pendingCheckpoint) }),
  };
}

export function parseArchiveEvent(value: unknown): ArchiveEvent {
  const raw = object(value, "event");
  return {
    id: string(raw.id, "event.id"),
    at: string(raw.at, "event.at"),
    type: string(raw.type, "event.type"),
    ...(raw.data === undefined ? {} : { data: raw.data }),
  };
}
