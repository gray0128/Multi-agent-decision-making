import { spawn } from "node:child_process";
import { MadError, RetryableMadError } from "../core/errors.js";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface RunProcessOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly participant?: boolean;
  readonly maxOutputBytes?: number;
}

export function runProcess(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.participant ? { ...process.env, MAD_PARTICIPANT: "1" } : process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let outputBytes = 0;
    const maximumOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES;

    const stop = (): void => {
      const terminate = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* process already exited */ }
      };
      terminate("SIGTERM");
      setTimeout(() => terminate("SIGKILL"), 2_000).unref();
    };
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        if (!outputExceeded) {
          outputExceeded = true;
          stop();
        }
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => { /* close/exit handler reports the authoritative result */ });
    child.once("error", (error) => {
      cleanup();
      reject(new MadError("EXECUTION", `无法启动 ${executable}：${error.message}`, { cause: error }));
    });
    child.once("close", (code) => {
      cleanup();
      if (aborted) return reject(new MadError("PAUSED", `${executable} 调用已中止`));
      if (timedOut) return reject(new RetryableMadError("EXECUTION", `${executable} 调用超时`));
      if (outputExceeded) return reject(new MadError("EXECUTION", `${executable} 输出超过上限 ${maximumOutputBytes} 字节`));
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? -1,
        durationMs: Math.round(performance.now() - started),
      });
    });
    timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timeout.unref();
    child.stdin.end(options.input);

    function cleanup(): void {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  });
}
