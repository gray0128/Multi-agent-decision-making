export const DELIBERATION_MODES = ["structured", "free"] as const;
export type DeliberationMode = (typeof DELIBERATION_MODES)[number];

export const INTERACTION_POLICIES = ["guided", "auto"] as const;
export type InteractionPolicy = (typeof INTERACTION_POLICIES)[number];

export const DELIBERATION_STATUSES = [
  "planning",
  "running",
  "waiting_checkpoint",
  "paused",
  "cancelled",
  "failed",
  "completed",
] as const;
export type DeliberationStatus = (typeof DELIBERATION_STATUSES)[number];

export interface InvocationPresetRef {
  readonly cli: string;
  readonly preset: string;
}

export interface DeliberationAgent {
  readonly id: string;
  readonly invocation: InvocationPresetRef;
  readonly role: string;
}

export interface ResourceLimits {
  readonly maxParticipants: number;
  readonly maxCalls: number;
  readonly maxDiscussionWindows: number;
  readonly timeoutSeconds: number;
  readonly contextBudget: number;
  readonly globalConcurrency?: number;
}

export interface DeliberationPlan {
  readonly organizer: InvocationPresetRef;
  readonly participants: readonly DeliberationAgent[];
  readonly reportAgentId: string;
  readonly moderatorAgentId?: string;
  readonly limits: ResourceLimits;
}

export interface WorkspaceAccess {
  readonly path: string;
  readonly mode: "direct-read-only";
}

export interface InvocationConfigSnapshot {
  readonly cli: string;
  readonly preset: string;
  readonly adapter: "codex" | "claude" | "reasonix" | "grok" | "pi" | "codebuddy" | "agy";
  readonly executable: string;
  readonly timeoutSeconds: number;
  readonly maxConcurrency: number;
  readonly model: string;
  readonly contextBudget: number;
  readonly options: {
    readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
    readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  };
}

export interface DeliberationManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly question: string;
  readonly mode: DeliberationMode;
  readonly interaction: InteractionPolicy;
  readonly plan?: DeliberationPlan;
  readonly registrySnapshot?: readonly InvocationConfigSnapshot[];
  readonly workspace?: WorkspaceAccess;
  readonly planConfirmation?: "interactive" | "auto-first-valid";
  readonly planning?: {
    readonly organizer: InvocationPresetRef;
    readonly limits: ResourceLimits;
    readonly autoConfirmPlan: boolean;
    readonly allowRegeneration: boolean;
    readonly projectMode: boolean;
    readonly generation: number;
    readonly candidateVersion?: number;
    readonly candidatePlan?: DeliberationPlan;
  };
}

export interface FrozenInvocation {
  readonly logicalCallId: string;
  readonly kind: "organizer" | "contribution" | "moderator" | "summary" | "draft" | "review" | "final";
  readonly agentId: string;
  readonly prompt: string;
  readonly invocation: InvocationPresetRef;
  readonly createdAt: string;
}

export interface InvocationResult {
  readonly logicalCallId: string;
  readonly text: string;
  readonly completedAt: string;
  readonly durationMs: number;
}
