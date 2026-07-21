import { spawn } from "node:child_process";
import { MadError } from "../core/errors.js";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export function runProcess(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly input?: string; readonly timeoutMs: number; readonly signal?: AbortSignal; readonly participant?: boolean },
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

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => { /* close/exit handler reports the authoritative result */ });
    child.once("error", (error) => {
      cleanup();
      reject(new MadError("EXECUTION", `无法启动 ${executable}：${error.message}`, { cause: error }));
    });
    child.once("close", (code) => {
      cleanup();
      if (aborted) return reject(new MadError("PAUSED", `${executable} 调用已中止`));
      if (timedOut) return reject(new MadError("EXECUTION", `${executable} 调用超时`));
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
