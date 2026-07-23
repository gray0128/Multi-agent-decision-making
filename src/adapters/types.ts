import type { CliConfig, InvocationPreset } from "./config.js";

export interface InvocationRequest {
  readonly prompt: string;
  readonly cwd: string;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly boundedJsonOutput?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AdapterResult {
  readonly text: string;
  readonly durationMs: number;
  readonly diagnostic: {
    readonly executable: string;
    readonly exitCode: number;
    readonly stderr: string;
  };
}

export interface PreflightResult {
  readonly ready: boolean;
  readonly version?: string;
  readonly detail?: string;
}

export type ProjectReadOnlyCapability = "unsupported" | "runtime-canary";

export interface ProjectReadOnlyVerification {
  readonly verified: boolean;
  readonly detail?: string;
}

export interface CliAdapter {
  readonly projectReadOnlyCapability: ProjectReadOnlyCapability;
  probe(signal?: AbortSignal, cwd?: string): Promise<PreflightResult>;
  check(cwd: string, signal?: AbortSignal): Promise<PreflightResult>;
  verifyProjectReadOnly(signal?: AbortSignal): Promise<ProjectReadOnlyVerification>;
  invoke(request: InvocationRequest): Promise<AdapterResult>;
}

export type AdapterFactory = (cli: CliConfig, preset: InvocationPreset) => CliAdapter;
