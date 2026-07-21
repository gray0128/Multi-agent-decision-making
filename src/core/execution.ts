import { randomUUID } from "node:crypto";
import type { AdapterFactory } from "../adapters/types.js";
import { createAdapter } from "../adapters/index.js";
import type { CliRegistry } from "../adapters/config.js";
import { resolveInvocation } from "../adapters/config.js";
import type { ArchiveStore } from "../archive/store.js";
import { MadError, RetryableMadError } from "./errors.js";
import type { FrozenInvocation, InvocationPresetRef, InvocationResult } from "./types.js";
import { estimateTokens } from "./tokens.js";

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  public constructor(private readonly maximum: number) {}

  public async use<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.maximum) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }
}

export async function settleAllOrThrow<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export class InvocationScheduler {
  private readonly global: Semaphore;
  private readonly perCli = new Map<string, Semaphore>();

  public constructor(globalMaximum = 6) {
    this.global = new Semaphore(globalMaximum);
  }

  public async run<T>(cliId: string, cliMaximum: number, operation: () => Promise<T>): Promise<T> {
    let local = this.perCli.get(cliId);
    if (!local) {
      local = new Semaphore(cliMaximum);
      this.perCli.set(cliId, local);
    }
    return local.use(() => this.global.use(operation));
  }
}

export interface LogicalInvocation<T> {
  readonly id: string;
  readonly kind: FrozenInvocation["kind"];
  readonly agentId: string;
  readonly invocation: InvocationPresetRef;
  readonly prompt: string;
  readonly stage: string;
  readonly parse?: (text: string) => T;
  readonly signal?: AbortSignal;
}

export interface LogicalInvocationOutput<T> {
  readonly value: T;
  readonly result: InvocationResult;
  readonly newlyCommitted: boolean;
}

export class InvocationRunner {
  private defaultSignal: AbortSignal | undefined;
  private timeoutSeconds: number | undefined;
  private readonly scheduler: InvocationScheduler;
  public constructor(
    private readonly registry: CliRegistry,
    private readonly archive: ArchiveStore,
    private readonly maxCalls: number,
    private readonly cwd = process.cwd(),
    private readonly adapterFactory: AdapterFactory = createAdapter,
    scheduler?: InvocationScheduler,
    globalMaximum = 6,
  ) {
    this.scheduler = scheduler ?? new InvocationScheduler(globalMaximum);
  }

  public setSignal(signal: AbortSignal | undefined): void {
    this.defaultSignal = signal;
  }

  public setTimeoutSeconds(timeoutSeconds: number): void {
    this.timeoutSeconds = timeoutSeconds;
  }

  public async run<T = string>(call: LogicalInvocation<T>): Promise<LogicalInvocationOutput<T>> {
    const resolved = resolveInvocation(this.registry, call.invocation.cli, call.invocation.preset);
    const inputTokens = estimateTokens(call.prompt);
    if (inputTokens > resolved.preset.contextBudget) {
      throw new MadError(
        "EXECUTION",
        `逻辑调用 ${call.id} 的输入估算为 ${inputTokens} tokens，超过上下文预算 ${resolved.preset.contextBudget}`,
      );
    }
    const frozen: FrozenInvocation = {
      logicalCallId: call.id,
      kind: call.kind,
      agentId: call.agentId,
      prompt: call.prompt,
      invocation: call.invocation,
      createdAt: new Date().toISOString(),
    };
    await this.archive.freezeInvocation(frozen);
    const state = await this.archive.readState();
    const completed = state.completedInvocations[call.id];
    if (completed) {
      await this.archive.ensureTranscript(this.transcriptRecord(call, completed));
      return { value: call.parse ? call.parse(completed.text) : completed.text as T, result: completed, newlyCommitted: false };
    }
    const adapter = this.adapterFactory(resolved.cli, resolved.preset);
    let lastError: unknown;
    for (let retry = 0; retry < 2; retry += 1) {
      const signal = call.signal ?? this.defaultSignal;
      if (signal?.aborted) throw new MadError("PAUSED", "逻辑调用在启动前已中止");
      const attemptNumber = await this.archive.beginAttempt(this.maxCalls);
      const attemptId = randomUUID();
      await this.archive.appendEvent("invocation.attempt_started", {
        attemptId,
        logicalCallId: call.id,
        attemptNumber,
        stage: call.stage,
        agentId: call.agentId,
      });
      try {
        const adapterResult = await this.scheduler.run(resolved.cli.id, resolved.cli.maxConcurrency, () =>
          adapter.invoke({
            prompt: call.prompt,
            cwd: this.cwd,
            ...(this.timeoutSeconds ? { timeoutMs: Math.min(this.timeoutSeconds, resolved.cli.timeoutSeconds) * 1_000 } : {}),
            ...(signal ? { signal } : {}),
          }),
        );
        let value: T;
        try {
          value = call.parse ? call.parse(adapterResult.text) : adapterResult.text as T;
        } catch (error) {
          throw new RetryableMadError(
            "EXECUTION",
            `逻辑调用 ${call.id} 的 schema 输出无效：${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        const result: InvocationResult = {
          logicalCallId: call.id,
          text: adapterResult.text,
          completedAt: new Date().toISOString(),
          durationMs: adapterResult.durationMs,
        };
        const committed = await this.archive.commitInvocation(result);
        await this.archive.appendDiagnostic({
          attemptId,
          logicalCallId: call.id,
          attemptNumber,
          at: new Date().toISOString(),
          status: "completed",
          durationMs: adapterResult.durationMs,
          diagnostic: adapterResult.diagnostic,
        });
        if (committed) {
          await this.archive.ensureTranscript(this.transcriptRecord(call, result));
        }
        return { value, result, newlyCommitted: committed };
      } catch (error) {
        const authoritative = (await this.archive.readState()).completedInvocations[call.id];
        if (authoritative) {
          await this.archive.ensureTranscript(this.transcriptRecord(call, authoritative));
          return {
            value: call.parse ? call.parse(authoritative.text) : authoritative.text as T,
            result: authoritative,
            newlyCommitted: false,
          };
        }
        lastError = error;
        await this.archive.appendDiagnostic({
          attemptId,
          logicalCallId: call.id,
          attemptNumber,
          at: new Date().toISOString(),
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof MadError && (error.code === "PAUSED" || error.code === "CANCELLED")) throw error;
        if (error instanceof MadError && !(error instanceof RetryableMadError)) throw error;
      }
    }
    throw new MadError("EXECUTION", `逻辑调用 ${call.id} 连续两次失败`, { cause: lastError });
  }

  private transcriptRecord<T>(call: LogicalInvocation<T>, result: InvocationResult): Record<string, unknown> & { logicalCallId: string } {
    return {
      id: randomUUID(),
      at: result.completedAt,
      logicalCallId: call.id,
      stage: call.stage,
      agentId: call.agentId,
      invocation: call.invocation,
      content: result.text,
    };
  }
}
