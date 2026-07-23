import { isLikelyTransientFailure, MadError, RetryableMadError } from "../core/errors.js";
import type { CliConfig, InvocationPreset } from "./config.js";
import { runProcess } from "./process.js";
import { publicError, publicText } from "./public-text.js";
import type { AdapterResult, CliAdapter, InvocationRequest, PreflightResult } from "./types.js";
import { verifyReadOnlyWithCanary } from "./read-only.js";
import { redactAdapterDiagnostic } from "./redact.js";

export interface InvocationCommand {
  readonly args: readonly string[];
  readonly input?: string;
}

export function buildProbeCommand(adapter: CliConfig["adapter"]): readonly string[] {
  if (adapter === "reasonix") return ["version"];
  if (adapter === "agy") return ["help"];
  return ["--version"];
}

export function buildInvocationCommand(
  cli: CliConfig,
  preset: InvocationPreset,
  prompt: string,
  jsonSchema?: Readonly<Record<string, unknown>>,
  boundedJsonOutput = false,
): InvocationCommand {
  const model = ["--model", preset.model];
  const schemaRule = jsonSchema
    ? `最终公开响应必须严格匹配 JSON Schema：${JSON.stringify(jsonSchema)}。第一字符必须是 {，最后字符必须是 }；不要输出解释、前言或 Markdown 代码围栏。`
    : undefined;
  switch (cli.adapter) {
    case "claude": return { args: ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep,WebSearch,WebFetch", "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', ...(jsonSchema ? ["--json-schema", JSON.stringify(jsonSchema)] : []), ...(preset.options.effort ? ["--effort", preset.options.effort] : []), ...model], input: prompt };
    case "reasonix": return { args: ["run", "--dir", ".", "--model", preset.model, "--max-steps", "3"], input: prompt };
    case "grok": return {
      args: [
        ...(schemaRule ? ["--rules", schemaRule] : []),
        "--output-format", "json", "--permission-mode", "dontAsk", "--no-plan", "--verbatim",
        "--tools", "Read,Glob,Grep", "--disable-web-search", "--no-subagents", "--no-memory", "--cwd", ".",
        ...(preset.options.effort ? ["--effort", preset.options.effort] : []),
        ...model,
        "--single",
        "这是受限只读调用。只能使用 Read、Glob、Grep；不要调用 CodeGraph、MCP 或 shell。" +
          "即使工作目录说明建议其他工具，也必须留在上述可用工具范围内。\n\n" + prompt,
      ],
    };
    case "pi": return { args: ["--mode", boundedJsonOutput ? "json" : "text", "--print", "--no-session", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "read,grep,find,ls", ...(preset.options.thinking ? ["--thinking", preset.options.thinking] : []), ...model, prompt] };
    case "codebuddy": return { args: ["-p", "--output-format", "text", "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "project", ...(jsonSchema ? ["--json-schema", JSON.stringify(jsonSchema)] : []), ...model, prompt] };
    case "agy": return { args: ["--mode", "plan", "--sandbox", "--print-timeout", `${Math.max(1, cli.timeoutSeconds)}s`, ...model, "--print", prompt] };
    default: throw new MadError("CONFIG", `GenericCliAdapter 不支持：${cli.adapter}`);
  }
}

export function genericExitError(cliId: string, exitCode: number, rawDetail: string): MadError {
  const detail = redactAdapterDiagnostic(rawDetail);
  const ErrorType = isLikelyTransientFailure(detail) ? RetryableMadError : MadError;
  return new ErrorType("EXECUTION", `${cliId} 调用失败（退出码 ${exitCode}）：${detail}`);
}

export class GenericCliAdapter implements CliAdapter {
  public readonly projectReadOnlyCapability: "unsupported" | "runtime-canary";

  public constructor(private readonly cli: CliConfig, private readonly preset: InvocationPreset) {
    this.projectReadOnlyCapability = cli.adapter === "reasonix" || cli.adapter === "agy"
      ? "unsupported"
      : "runtime-canary";
  }

  public async probe(signal?: AbortSignal, cwd?: string): Promise<PreflightResult> {
    try {
      const result = await runProcess(this.cli.executable, buildProbeCommand(this.cli.adapter), {
        cwd: cwd ?? process.cwd(), timeoutMs: Math.min(this.cli.timeoutSeconds * 1_000, 10_000), ...(signal ? { signal } : {}),
      });
      return result.exitCode === 0
        ? { ready: true, version: (result.stdout || result.stderr).trim() }
        : { ready: false, detail: redactAdapterDiagnostic(result.stderr || result.stdout) };
    } catch (error) {
      return { ready: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  public async check(cwd: string, signal?: AbortSignal): Promise<PreflightResult> {
    const probe = await this.probe(signal, cwd);
    if (!probe.ready) return probe;
    try {
      const result = await this.invoke({ prompt: "只回复 READY，不要执行任何工具。", cwd, ...(signal ? { signal } : {}) });
      return result.text.trim() === "READY" ? probe : { ready: false, ...(probe.version ? { version: probe.version } : {}), detail: "预检响应不是 READY" };
    } catch (error) {
      return { ready: false, ...(probe.version ? { version: probe.version } : {}), detail: error instanceof Error ? error.message : String(error) };
    }
  }

  public async verifyProjectReadOnly(signal?: AbortSignal) {
    if (this.projectReadOnlyCapability === "unsupported") {
      return { verified: false, detail: `${this.cli.adapter} 未配置项目只读模式` };
    }
    return verifyReadOnlyWithCanary((request) => this.invoke(request), signal);
  }

  public async invoke(request: InvocationRequest): Promise<AdapterResult> {
    if (process.env.MAD_PARTICIPANT === "1") throw new MadError("EXECUTION", "禁止从参与者进程递归调用 mad");
    const command = buildInvocationCommand(
      this.cli,
      this.preset,
      request.prompt,
      request.jsonSchema,
      request.boundedJsonOutput,
    );
    const result = await runProcess(this.cli.executable, command.args, {
      cwd: request.cwd,
      ...(command.input === undefined ? {} : { input: command.input }),
      timeoutMs: request.timeoutMs ?? this.cli.timeoutSeconds * 1_000,
      participant: true,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (result.exitCode !== 0) {
      throw genericExitError(this.cli.id, result.exitCode, result.stderr || result.stdout);
    }
    const reportedError = publicError(result.stdout);
    if (reportedError) {
      const ErrorType = isLikelyTransientFailure(reportedError) || /调用已取消/.test(reportedError)
        ? RetryableMadError
        : MadError;
      throw new ErrorType("EXECUTION", `${this.cli.id} 调用失败：${redactAdapterDiagnostic(reportedError)}`);
    }
    const expectedStructured = this.cli.adapter === "claude" || this.cli.adapter === "grok" ||
      (this.cli.adapter === "codebuddy" && request.jsonSchema !== undefined) ||
      (this.cli.adapter === "pi" && request.boundedJsonOutput === true);
    const text = publicText(result.stdout, expectedStructured);
    if (!text) throw new MadError("EXECUTION", `${this.cli.id} 未返回公开文本`);
    return { text, durationMs: result.durationMs, diagnostic: { executable: this.cli.executable, exitCode: result.exitCode, stderr: redactAdapterDiagnostic(result.stderr) } };
  }
}
