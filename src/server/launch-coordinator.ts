import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "../core/paths.js";
import type { DeliberationMode, InteractionPolicy, InvocationPresetRef, ResourceLimits } from "../core/types.js";
import { ArchiveStore } from "../archive/store.js";
import { redactAdapterDiagnostic } from "../adapters/redact.js";

export interface WebLaunchRequest {
  readonly requestId: string;
  readonly topic: string;
  readonly mode: DeliberationMode;
  readonly interaction: InteractionPolicy;
  readonly workspace?: string;
  readonly organizer?: InvocationPresetRef;
  readonly limits?: ResourceLimits;
}

export interface LaunchRecord {
  readonly requestId: string;
  readonly deliberationId: string;
  readonly status: "reserved" | "spawned" | "planning" | "finished" | "failed";
  readonly createdAt: string;
  readonly error?: string;
}

export type DeliberationProcessLauncher = (
  request: WebLaunchRequest,
  deliberationId: string,
) => Promise<void>;

export class ActiveLaunchConflict extends Error {
  public constructor(public readonly deliberationId: string) {
    super("当前 MAD_HOME 已有活动审议");
  }
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function defaultProcessLauncher(paths: AppPaths): DeliberationProcessLauncher {
  return async (request, deliberationId) => {
    const entry = process.argv[1];
    if (!entry) throw new Error("无法确定 mad CLI 入口");
    const args = [
      ...process.execArgv,
      entry,
      "deliberate",
      request.topic,
      "--mode",
      request.mode,
      "--id",
      deliberationId,
      "--web-plan",
      "--format",
      "json",
    ];
    if (request.interaction === "auto") args.push("--auto");
    if (request.workspace) args.push("--workspace", request.workspace);
    if (request.organizer) args.push("--organizer", `${request.organizer.cli}/${request.organizer.preset}`);
    if (request.limits) {
      args.push(
        "--max-participants", String(request.limits.maxParticipants),
        "--max-calls", String(request.limits.maxCalls),
        "--max-discussion-windows", String(request.limits.maxDiscussionWindows),
        "--timeout-seconds", String(request.limits.timeoutSeconds),
        "--context-budget", String(request.limits.contextBudget),
      );
      if (request.limits.globalConcurrency !== undefined) {
        args.push("--global-concurrency", String(request.limits.globalConcurrency));
      }
    }
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MAD_HOME: paths.home },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  };
}

export class LaunchCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private readonly directory: string;

  public constructor(
    private readonly paths: AppPaths,
    private readonly launcher: DeliberationProcessLauncher = defaultProcessLauncher(paths),
  ) {
    this.directory = join(paths.runtime, "launches");
  }

  public async launch(request: WebLaunchRequest): Promise<LaunchRecord> {
    let result: LaunchRecord | undefined;
    const operation = this.queue.then(async () => { result = await this.launchExclusive(request); });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result!;
  }

  public async read(requestId: string): Promise<LaunchRecord | null> {
    try {
      const record = JSON.parse(await readFile(this.recordPath(requestId), "utf8")) as LaunchRecord;
      const resolved = await this.withArchiveStatus(record);
      if (resolved.status !== record.status) await atomicJson(this.recordPath(requestId), resolved);
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async launchExclusive(request: WebLaunchRequest): Promise<LaunchRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const existing = await this.read(request.requestId);
    if (existing) return existing;
    const active = await this.activeDeliberationId() ?? await this.pendingDeliberationId(request.requestId);
    if (active) throw new ActiveLaunchConflict(active);
    const record: LaunchRecord = {
      requestId: request.requestId,
      deliberationId: randomUUID(),
      status: "reserved",
      createdAt: new Date().toISOString(),
    };
    await atomicJson(this.recordPath(request.requestId), record);
    try {
      await this.launcher(request, record.deliberationId);
      const spawned = { ...record, status: "spawned" as const };
      await atomicJson(this.recordPath(request.requestId), spawned);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const current = await this.withArchiveStatus(spawned);
        if (current.status === "planning") {
          await atomicJson(this.recordPath(request.requestId), current);
          return current;
        }
        await delay(100);
      }
      return spawned;
    } catch (error) {
      const failed: LaunchRecord = {
        ...record,
        status: "failed",
        error: redactAdapterDiagnostic(error instanceof Error ? error.message : String(error)),
      };
      await atomicJson(this.recordPath(request.requestId), failed);
      return failed;
    }
  }

  private async withArchiveStatus(record: LaunchRecord): Promise<LaunchRecord> {
    if (record.status === "failed") return record;
    try {
      const state = await new ArchiveStore(this.paths.deliberations, record.deliberationId).readState();
      if (state.status === "failed") {
        return { ...record, status: "failed", error: "审议进程在规划阶段失败；请查看脱敏档案诊断" };
      }
      return {
        ...record,
        status: ["completed", "cancelled", "paused"].includes(state.status) ? "finished" : "planning",
      };
    } catch {
      if (Date.now() - Date.parse(record.createdAt) > 10_000) {
        return { ...record, status: "failed", error: "审议进程未能在期限内建立规划档案" };
      }
      return record;
    }
  }

  private recordPath(requestId: string): string {
    return join(this.directory, `${requestId}.json`);
  }

  private async activeDeliberationId(): Promise<string | null> {
    try {
      const value = JSON.parse(await readFile(join(this.paths.runtime, "active.lock"), "utf8")) as {
        deliberationId?: unknown;
        pid?: unknown;
      };
      if (typeof value.deliberationId !== "string" || !Number.isSafeInteger(value.pid)) return null;
      process.kill(value.pid as number, 0);
      return value.deliberationId;
    } catch {
      return null;
    }
  }

  private async pendingDeliberationId(exceptRequestId: string): Promise<string | null> {
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json") || name === `${exceptRequestId}.json`) continue;
      try {
        const record = JSON.parse(await readFile(join(this.directory, name), "utf8")) as LaunchRecord;
        const resolved = await this.withArchiveStatus(record);
        if (resolved.status === "reserved" || resolved.status === "spawned") {
          return resolved.deliberationId;
        }
      } catch { /* ignore malformed or concurrently replaced coordination records */ }
    }
    return null;
  }
}
