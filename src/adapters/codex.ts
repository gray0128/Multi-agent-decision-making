import { isLikelyTransientFailure, MadError, RetryableMadError } from "../core/errors.js";
import type { CliConfig, InvocationPreset } from "./config.js";
import { runProcess } from "./process.js";
import type { AdapterResult, CliAdapter, InvocationRequest, PreflightResult } from "./types.js";

export class CodexAdapter implements CliAdapter {
  public readonly supportsProjectReadOnly = true;
  public constructor(
    private readonly cli: CliConfig,
    private readonly preset: InvocationPreset,
  ) {}

  public async probe(signal?: AbortSignal, cwd?: string): Promise<PreflightResult> {
    try {
      const result = await runProcess(this.cli.executable, ["--version"], {
        cwd: cwd ?? process.cwd(),
        timeoutMs: Math.min(this.cli.timeoutSeconds * 1_000, 10_000),
        ...(signal ? { signal } : {}),
      });
      return result.exitCode === 0
        ? { ready: true, version: result.stdout.trim() || result.stderr.trim() }
        : { ready: false, detail: this.redact(result.stderr) || `退出码 ${result.exitCode}` };
    } catch (error) {
      return { ready: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  public async check(cwd: string, signal?: AbortSignal): Promise<PreflightResult> {
    const probe = await this.probe(signal, cwd);
    if (!probe.ready) return probe;
    try {
      const result = await this.invoke({
        prompt: "这是运行时预检。不要使用任何工具，只回复 READY。",
        cwd,
        timeoutMs: this.cli.timeoutSeconds * 1_000,
        ...(signal ? { signal } : {}),
      });
      return result.text.trim() === "READY"
        ? probe
        : { ready: false, ...(probe.version ? { version: probe.version } : {}), detail: "预检响应不是 READY" };
    } catch (error) {
      return {
        ready: false,
        ...(probe.version ? { version: probe.version } : {}),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async invoke(request: InvocationRequest): Promise<AdapterResult> {
    if (process.env.MAD_PARTICIPANT === "1") throw new MadError("EXECUTION", "禁止从参与者进程递归调用 mad");
    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--model",
      this.preset.model,
    ];
    if (this.preset.options.reasoningEffort) {
      args.push("--config", `model_reasoning_effort=${JSON.stringify(this.preset.options.reasoningEffort)}`);
    }
    args.push("-");
    const result = await runProcess(this.cli.executable, args, {
      cwd: request.cwd,
      input: request.prompt,
      timeoutMs: request.timeoutMs ?? this.cli.timeoutSeconds * 1_000,
      participant: true,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (result.exitCode !== 0) {
      const detail = this.redact(result.stderr);
      const ErrorType = isLikelyTransientFailure(detail) ? RetryableMadError : MadError;
      throw new ErrorType("EXECUTION", `Codex 调用失败（退出码 ${result.exitCode}）：${detail}`);
    }
    const text = result.stdout.trim();
    if (!text) throw new MadError("EXECUTION", "Codex 调用没有返回最终文本");
    return {
      text,
      durationMs: result.durationMs,
      diagnostic: {
        executable: this.cli.executable,
        exitCode: result.exitCode,
        stderr: this.redact(result.stderr),
      },
    };
  }

  private redact(value: string): string {
    let redacted = value
      .replace(/(bearer|token|api[_-]?key|authorization)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
      .replace(/\b(?:sk|xai|ghp|github_pat|glpat)-?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
    for (const [name, secret] of Object.entries(process.env)) {
      if (secret && secret.length >= 8 && /(TOKEN|KEY|SECRET|PASSWORD)/i.test(name)) redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted.slice(0, 4_000).trim();
  }
}
