import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { SERVER_HOST } from "./constants.js";

export interface PendingCheckpoint {
  readonly kind: string;
  readonly summary: string;
  readonly actions: readonly string[];
}

export interface CheckpointResponse {
  readonly checkpointId: string;
  readonly action: string;
  readonly guidance: string;
  readonly at: string;
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function publishExclusiveJson(path: string, value: unknown): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary);
  }
}

export class CheckpointMailbox {
  private readonly directory: string;
  private readonly requestPath: string;
  private readonly responsePath: string;

  public constructor(runtime: string, private readonly deliberationId: string) {
    this.directory = join(runtime, "checkpoints");
    this.requestPath = join(this.directory, `${deliberationId}.request.json`);
    this.responsePath = join(this.directory, `${deliberationId}.response.json`);
  }

  public async wait(
    pending: PendingCheckpoint,
    local?: (signal: AbortSignal) => Promise<{ action: string; guidance?: string }>,
    signal?: AbortSignal,
    onPublished?: (checkpointId: string) => Promise<void>,
    existingCheckpointId?: string,
    onAccepted?: (response: CheckpointResponse) => Promise<void>,
  ): Promise<CheckpointResponse> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!existingCheckpointId) await this.remove(this.responsePath);
    const checkpointId = existingCheckpointId ?? randomUUID();
    const request = { deliberationId: this.deliberationId, checkpointId, ...pending, createdAt: new Date().toISOString() };
    const temporary = `${this.requestPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(request)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, this.requestPath);
    await onPublished?.(checkpointId);
    const abort = new AbortController();
    const onExternalAbort = (): void => { void this.submit(checkpointId, "pause"); };
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (signal?.aborted) onExternalAbort();
    let localError: unknown;
    let consumed = false;
    const localTask = local?.(abort.signal).then(async (response) => {
      await this.submit(checkpointId, response.action, response.guidance ?? "");
    }).catch((error: unknown) => {
      if (!(error instanceof Error && error.name === "AbortError")) localError = error;
    });
    try {
      while (true) {
        if (localError) throw localError;
        try {
          const response = JSON.parse(await readFile(this.responsePath, "utf8")) as CheckpointResponse;
          if (response.checkpointId === checkpointId && pending.actions.includes(response.action)) {
            await onAccepted?.(response);
            consumed = true;
            return response;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(200);
      }
    } finally {
      abort.abort();
      signal?.removeEventListener("abort", onExternalAbort);
      await localTask;
      if (consumed) await Promise.all([this.remove(this.requestPath), this.remove(this.responsePath)]);
    }
  }

  public async submit(checkpointId: string, action: string, guidance = ""): Promise<boolean> {
    return publishExclusiveJson(this.responsePath, {
      checkpointId,
      action,
      guidance,
      at: new Date().toISOString(),
    });
  }

  private async remove(path: string): Promise<void> {
    try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function observerIsOnline(runtime: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(join(runtime, "server.json"), "utf8")) as { pid?: unknown; port?: unknown };
    if (!Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.port)) return false;
    process.kill(value.pid as number, 0);
    return await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: SERVER_HOST, port: value.port as number });
      let settled = false;
      const finish = (online: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(online);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(300, () => finish(false));
    });
  } catch {
    return false;
  }
}
