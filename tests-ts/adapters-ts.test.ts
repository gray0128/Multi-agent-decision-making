import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterId, CliConfig, InvocationPreset } from "../src/adapters/config.js";
import { buildInvocationCommand, buildProbeCommand, GenericCliAdapter, genericExitError } from "../src/adapters/generic.js";
import { publicError, publicText } from "../src/adapters/public-text.js";
import { runProcess } from "../src/adapters/process.js";
import { RetryableMadError } from "../src/core/errors.js";
import { codexParticipantPrompt } from "../src/adapters/codex.js";
import { redactAdapterDiagnostic } from "../src/adapters/redact.js";

const preset: InvocationPreset = { id: "deep", model: "model-id", contextBudget: 64_000, options: {} };
function cli(adapter: AdapterId): CliConfig {
  return { id: adapter, adapter, executable: adapter, timeoutSeconds: 45, maxConcurrency: 1, presets: [preset] };
}

describe("typed CLI adapters", () => {
  it("prevents a Codex participant from recursively starting MAD", () => {
    const prompt = codexParticipantPrompt("审议当前项目");

    expect(prompt).toContain("审议当前项目");
    expect(prompt).toMatch(/不要调用 mad/);
    expect(prompt).toMatch(/deliberate-with-mad/);
  });

  it("terminates a child process whose combined output exceeds the configured limit", async () => {
    await expect(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    })).rejects.toThrow(/输出超过上限/);
  });

  it.each([
    ["claude", ["--permission-mode", "dontAsk", "--no-session-persistence"]],
    ["grok", ["--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", "--no-subagents", "--no-memory"]],
    ["pi", ["--no-approve", "--no-session", "--no-extensions", "--tools", "read,grep,find,ls"]],
    ["codebuddy", ["--permission-mode", "dontAsk", "--strict-mcp-config", "--setting-sources", "project"]],
    ["agy", ["--mode", "plan", "--sandbox"]],
  ] as const)("pins the %s read-only/non-persistent boundary", (adapter, required) => {
    const command = buildInvocationCommand(cli(adapter), preset, "prompt");
    for (const item of required) expect(command.args).toContain(item);
    expect(command.args).toContain("model-id");
  });

  it("keeps CodeBuddy out of its interactive plan workflow", () => {
    const command = buildInvocationCommand(cli("codebuddy"), preset, "inspect the repository");
    const permissionIndex = command.args.indexOf("--permission-mode");

    expect(command.args[permissionIndex + 1]).toBe("dontAsk");
    expect(command.args).not.toContain("plan");
  });

  it("keeps Claude structured output out of its plan workflow", () => {
    const command = buildInvocationCommand(cli("claude"), preset, "build a plan", { type: "object" });
    const permissionIndex = command.args.indexOf("--permission-mode");

    expect(command.args[permissionIndex + 1]).toBe("dontAsk");
    expect(command.args).not.toContain("plan");
  });

  it("uses CodeBuddy final text transport for both ordinary and schema calls", () => {
    const ordinary = buildInvocationCommand(cli("codebuddy"), preset, "inspect the repository");
    const structured = buildInvocationCommand(cli("codebuddy"), preset, "inspect the repository", { type: "object" });
    const ordinaryFormat = ordinary.args.indexOf("--output-format");
    const structuredFormat = structured.args.indexOf("--output-format");

    expect(ordinary.args[ordinaryFormat + 1]).toBe("text");
    expect(structured.args[structuredFormat + 1]).toBe("text");
  });

  it("keeps Grok structured output out of its plan workflow and preserves the prompt verbatim", () => {
    const command = buildInvocationCommand(cli("grok"), preset, "inspect the repository", { type: "object" });
    const permissionIndex = command.args.indexOf("--permission-mode");

    expect(command.args[permissionIndex + 1]).toBe("dontAsk");
    expect(command.args).toContain("--no-plan");
    expect(command.args).toContain("--verbatim");
    expect(command.args).toContain("--disable-web-search");
    expect(command.args).not.toContain("plan");
  });

  it("keeps Reasonix bounded but does not claim project read-only support", () => {
    const command = buildInvocationCommand(cli("reasonix"), preset, "prompt");
    expect(command.args).toEqual(["run", "--dir", ".", "--model", "model-id", "--max-steps", "3"]);
  });

  it("does not claim project read-only support for AGY's terminal-only sandbox", () => {
    expect(new GenericCliAdapter(cli("agy"), preset).projectReadOnlyCapability).toBe("unsupported");
  });

  it("uses adapter-specific non-model probe commands", () => {
    expect(buildProbeCommand("reasonix")).toEqual(["version"]);
    expect(buildProbeCommand("agy")).toEqual(["help"]);
    expect(buildProbeCommand("claude")).toEqual(["--version"]);
  });

  it("maps only typed adapter-specific reasoning options", () => {
    const claude = buildInvocationCommand(cli("claude"), { ...preset, options: { effort: "xhigh" } }, "prompt");
    const grok = buildInvocationCommand(cli("grok"), { ...preset, options: { effort: "high" } }, "prompt");
    const pi = buildInvocationCommand(cli("pi"), { ...preset, options: { thinking: "medium" } }, "prompt");
    expect(claude.args).toEqual(expect.arrayContaining(["--effort", "xhigh", "--safe-mode", "--strict-mcp-config"]));
    expect(grok.args).toEqual(expect.arrayContaining(["--effort", "high"]));
    expect(pi.args).toEqual(expect.arrayContaining(["--print", "--thinking", "medium"]));
  });

  it("tells Grok to stay within the pinned read-only tools", () => {
    const command = buildInvocationCommand(cli("grok"), preset, "inspect the repository");
    const prompt = command.args.at(-1);

    expect(prompt).toContain("inspect the repository");
    expect(prompt).toMatch(/Read、Glob、Grep/);
    expect(prompt).toMatch(/不要调用 CodeGraph、MCP 或 shell/);
  });

  it("uses Pi final-text output instead of the unbounded JSON event stream", () => {
    const command = buildInvocationCommand(cli("pi"), preset, "inspect the repository");
    const modeIndex = command.args.indexOf("--mode");

    expect(command.args[modeIndex + 1]).toBe("text");
    expect(command.args).toContain("--print");
  });

  it("keeps Pi structured calls on bounded final-text output", () => {
    const command = buildInvocationCommand(cli("pi"), preset, "verify read-only", { type: "object" });
    const modeIndex = command.args.indexOf("--mode");

    expect(command.args[modeIndex + 1]).toBe("text");
  });

  it("uses Pi JSON events only for explicitly bounded output", () => {
    const command = buildInvocationCommand(cli("pi"), preset, "verify read-only", { type: "object" }, true);
    const modeIndex = command.args.indexOf("--mode");

    expect(command.args[modeIndex + 1]).toBe("json");
  });

  it("maps a structured output schema to Claude without affecting ordinary calls", () => {
    const schema = {
      type: "object",
      properties: { status: { type: "string", enum: ["blocked"] } },
      required: ["status"],
      additionalProperties: false,
    } as const;
    const structured = buildInvocationCommand(cli("claude"), preset, "prompt", schema);
    const ordinary = buildInvocationCommand(cli("claude"), preset, "prompt");
    const schemaIndex = structured.args.indexOf("--json-schema");

    expect(schemaIndex).toBeGreaterThan(-1);
    expect(structured.args[schemaIndex + 1]).toBe(JSON.stringify(schema));
    expect(ordinary.args).not.toContain("--json-schema");
  });

  it("uses native CodeBuddy schema validation for structured calls", () => {
    const schema = { type: "object", required: ["position"] } as const;
    const command = buildInvocationCommand(cli("codebuddy"), preset, "prompt", schema);
    const schemaIndex = command.args.indexOf("--json-schema");

    expect(command.args[schemaIndex + 1]).toBe(JSON.stringify(schema));
  });

  it("adds a system-level Grok rule for structured output", () => {
    const schema = { type: "object", required: ["position"] } as const;
    const command = buildInvocationCommand(cli("grok"), preset, "prompt", schema);
    const rulesIndex = command.args.indexOf("--rules");

    expect(command.args[rulesIndex + 1]).toContain(JSON.stringify(schema));
    expect(command.args[rulesIndex + 1]).toMatch(/第一字符.*\{/);
  });

  it("extracts only public assistant text from JSON and JSONL outputs", () => {
    expect(publicText(JSON.stringify({ type: "result", result: "final" }))).toBe("final");
    expect(publicText([
      JSON.stringify({ type: "progress", text: "internal progress" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
    ].join("\n"))).toContain("answer");
  });

  it("does not expose a truncated structured transcript as public text", () => {
    const truncated = '[{"type":"message","role":"user","content":[{"type":"input_text","text":"secret prompt"}]';

    expect(publicText(truncated, true)).toBe("");
  });

  it("preserves a direct structured JSON payload that is not a CLI transport envelope", () => {
    const payload = JSON.stringify({ position: "revised", disputes: [] });

    expect(publicText(payload, true)).toBe(payload);
  });

  it("keeps the root cause at the tail of oversized adapter diagnostics", () => {
    const diagnostic = `${"prompt echo\n".repeat(500)}ERROR: You've hit your usage limit.`;

    expect(redactAdapterDiagnostic(diagnostic)).toContain("You've hit your usage limit");
  });

  it("removes Reasonix thinking markers and terminal control sequences", () => {
    expect(publicText("\u001b[31m▎ thinking\npublic answer\n· 10 tok · 1s\u001b[0m")).toBe("public answer");
  });

  it("does not expose a user prompt as model output and extracts zero-exit JSON errors", () => {
    const raw = [
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "PROMPT" }] } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid api key" },
      }),
    ].join("\n");
    expect(publicText(raw)).toBe("");
    expect(publicError(raw)).toBe("401 invalid api key");
  });

  it("treats a zero-exit cancelled response as a public invocation error", () => {
    const raw = JSON.stringify({ text: "partial", stopReason: "Cancelled" });
    expect(publicError(raw)).toMatch(/调用已取消.*Cancelled/);
  });

  it("classifies a zero-exit cancelled response as retryable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mad-cancelled-adapter-"));
    const executable = join(directory, "cancelled-cli");
    await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' '{\"text\":\"partial\",\"stopReason\":\"Cancelled\"}'\n");
    await chmod(executable, 0o755);
    const adapter = new GenericCliAdapter({ ...cli("grok"), executable }, preset);

    try {
      await expect(adapter.invoke({ prompt: "prompt", cwd: process.cwd() })).rejects.toBeInstanceOf(RetryableMadError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies a non-zero generic CLI exit without exposing its secret", () => {
    const message = genericExitError("agy", 1, "token=fake-sensitive-token-123456").message;
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("fake-sensitive-token-123456");
  });
});
