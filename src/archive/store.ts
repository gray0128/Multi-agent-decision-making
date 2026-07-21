import { appendFile, chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MadError } from "../core/errors.js";
import type { DeliberationManifest, FrozenInvocation, InvocationResult } from "../core/types.js";

export interface DeliberationState {
  readonly schemaVersion: 1;
  readonly status: "planning" | "running" | "waiting_checkpoint" | "paused" | "cancelled" | "failed" | "completed";
  readonly updatedAt: string;
  readonly callAttempts: number;
  readonly guidance: readonly string[];
  readonly pendingInvocations: Readonly<Record<string, FrozenInvocation>>;
  readonly completedInvocations: Readonly<Record<string, InvocationResult>>;
}

export interface ArchiveEvent {
  readonly id: string;
  readonly at: string;
  readonly type: string;
  readonly data?: unknown;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export class ArchiveStore {
  public readonly path: string;
  private mutationQueue: Promise<void> = Promise.resolve();
  private transcriptQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly root: string,
    public readonly deliberationId: string,
  ) {
    this.path = join(root, deliberationId);
  }

  public async create(manifest: DeliberationManifest): Promise<void> {
    await mkdir(this.path, { recursive: false, mode: 0o700 });
    const { schemaVersion: _schemaVersion, ...manifestValue } = manifest;
    await atomicJson(join(this.path, "manifest.json"), { schema_version: 1, ...manifestValue });
    await this.writeState({
      schemaVersion: 1,
      status: "planning",
      updatedAt: new Date().toISOString(),
      callAttempts: 0,
      guidance: [],
      pendingInvocations: {},
      completedInvocations: {},
    });
    await Promise.all(
      ["events.jsonl", "transcript.jsonl", "diagnostics.jsonl"].map((name) =>
        writeFile(join(this.path, name), "", { flag: "wx", mode: 0o600 }),
      ),
    );
    await this.appendEvent("archive.created");
  }

  public async readState(): Promise<DeliberationState> {
    const value: unknown = JSON.parse(await readFile(join(this.path, "state.json"), "utf8"));
    const version = typeof value === "object" && value !== null
      ? ((value as { schema_version?: unknown }).schema_version ?? (value as { schemaVersion?: unknown }).schemaVersion)
      : undefined;
    if (typeof value !== "object" || value === null || version !== 1) {
      throw new MadError("EXECUTION", `不支持的审议状态：${this.deliberationId}`);
    }
    const { schema_version: _snakeVersion, ...rest } = value as Record<string, unknown>;
    return { ...rest, schemaVersion: 1 } as unknown as DeliberationState;
  }

  public async writeState(state: DeliberationState): Promise<void> {
    const { schemaVersion: _schemaVersion, ...value } = state;
    await atomicJson(join(this.path, "state.json"), { schema_version: 1, ...value });
  }

  public async freezeInvocation(invocation: FrozenInvocation): Promise<void> {
    let changed = false;
    await this.mutateState((state) => {
      if (state.completedInvocations[invocation.logicalCallId]) return state;
      const existing = state.pendingInvocations[invocation.logicalCallId];
      if (existing && (
        existing.kind !== invocation.kind ||
        existing.agentId !== invocation.agentId ||
        existing.prompt !== invocation.prompt ||
        existing.invocation.cli !== invocation.invocation.cli ||
        existing.invocation.preset !== invocation.invocation.preset
      )) {
        throw new MadError("EXECUTION", `逻辑调用冻结输入不一致：${invocation.logicalCallId}`);
      }
      if (existing) return state;
      changed = true;
      return {
        ...state,
        updatedAt: new Date().toISOString(),
        pendingInvocations: { ...state.pendingInvocations, [invocation.logicalCallId]: invocation },
      };
    });
    if (changed) await this.appendEvent("invocation.frozen", { logicalCallId: invocation.logicalCallId, kind: invocation.kind });
  }

  public async commitInvocation(result: InvocationResult): Promise<boolean> {
    let committed = false;
    await this.mutateState((state) => {
      if (state.completedInvocations[result.logicalCallId]) return state;
      if (!state.pendingInvocations[result.logicalCallId]) {
        throw new MadError("EXECUTION", `逻辑调用尚未冻结：${result.logicalCallId}`);
      }
      const pending = { ...state.pendingInvocations };
      delete pending[result.logicalCallId];
      committed = true;
      return {
        ...state,
        updatedAt: new Date().toISOString(),
        pendingInvocations: pending,
        completedInvocations: { ...state.completedInvocations, [result.logicalCallId]: result },
      };
    });
    if (!committed) return false;
    await this.appendEvent("invocation.committed", { logicalCallId: result.logicalCallId, durationMs: result.durationMs });
    return true;
  }

  public async beginAttempt(maxCalls: number): Promise<number> {
    let attempt = 0;
    await this.mutateState((state) => {
      if (state.callAttempts >= maxCalls) throw new MadError("EXECUTION", `模型调用次数达到上限 ${maxCalls}`);
      attempt = state.callAttempts + 1;
      return { ...state, callAttempts: attempt, updatedAt: new Date().toISOString() };
    });
    return attempt;
  }

  public async setStatus(status: DeliberationState["status"]): Promise<void> {
    await this.mutateState((state) => ({ ...state, status, updatedAt: new Date().toISOString() }));
    await this.appendEvent(`deliberation.${status}`);
  }

  public async addGuidance(guidance: string): Promise<void> {
    const value = guidance.trim();
    if (!value) return;
    await this.mutateState((state) => ({
      ...state,
      guidance: [...state.guidance, value],
      updatedAt: new Date().toISOString(),
    }));
    await this.appendEvent("checkpoint.guidance", { guidance: value });
  }

  public async readManifest(): Promise<DeliberationManifest> {
    const value: unknown = JSON.parse(await readFile(join(this.path, "manifest.json"), "utf8"));
    const version = typeof value === "object" && value !== null
      ? ((value as { schema_version?: unknown }).schema_version ?? (value as { schemaVersion?: unknown }).schemaVersion)
      : undefined;
    if (typeof value !== "object" || value === null || version !== 1) {
      throw new MadError("EXECUTION", `不支持的审议清单：${this.deliberationId}`);
    }
    const { schema_version: _snakeVersion, ...rest } = value as Record<string, unknown>;
    return { ...rest, schemaVersion: 1 } as unknown as DeliberationManifest;
  }

  public async ensureTranscript(record: Record<string, unknown> & { readonly logicalCallId: string }): Promise<void> {
    const operation = this.transcriptQueue.then(async () => {
      const path = join(this.path, "transcript.jsonl");
      const existing = (await readFile(path, "utf8")).split("\n").filter(Boolean).some((line) => {
        const value = JSON.parse(line) as { logicalCallId?: unknown };
        return value.logicalCallId === record.logicalCallId;
      });
      if (!existing) await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.transcriptQueue = operation.catch(() => undefined);
    await operation;
  }

  public async appendDiagnostic(record: unknown): Promise<void> {
    await appendFile(join(this.path, "diagnostics.jsonl"), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  public async appendEvent(type: string, data?: unknown): Promise<void> {
    const event: ArchiveEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
      ...(data === undefined ? {} : { data }),
    };
    await appendFile(join(this.path, "events.jsonl"), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  public async writeReport(markdown: string): Promise<void> {
    const path = join(this.path, "report.md");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }

  private async mutateState(transform: (state: DeliberationState) => DeliberationState): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      const state = await this.readState();
      await this.writeState(transform(state));
    });
    this.mutationQueue = operation.catch(() => undefined);
    await operation;
  }
}

export class ActiveDeliberationLock {
  private handle: Awaited<ReturnType<typeof open>> | undefined;

  public constructor(private readonly path: string) {}

  public async acquire(deliberationId: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.handle = await open(this.path, "wx", 0o600);
        await this.handle.writeFile(`${JSON.stringify({ deliberationId, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0 || !await this.reclaimStale()) {
          throw new MadError("LOCKED", "当前 MAD_HOME 已有活动审议", { cause: error });
        }
      }
    }
  }

  public async release(): Promise<void> {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = undefined;
    await unlink(this.path);
  }

  private async reclaimStale(): Promise<boolean> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as { pid?: unknown };
      if (!Number.isSafeInteger(value.pid)) return false;
      try {
        process.kill(value.pid as number, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
      await unlink(this.path);
      return true;
    } catch {
      return false;
    }
  }
}
