import { describe, expect, it } from "vitest";
import type { AdapterId, CliConfig, InvocationPreset } from "../src/adapters/config.js";
import { buildInvocationCommand, buildProbeCommand, genericExitError } from "../src/adapters/generic.js";
import { publicError, publicText } from "../src/adapters/public-text.js";
import { runProcess } from "../src/adapters/process.js";

const preset: InvocationPreset = { id: "deep", model: "model-id", contextBudget: 64_000, options: {} };
function cli(adapter: AdapterId): CliConfig {
  return { id: adapter, adapter, executable: adapter, timeoutSeconds: 45, maxConcurrency: 1, presets: [preset] };
}

describe("typed CLI adapters", () => {
  it("terminates a child process whose combined output exceeds the configured limit", async () => {
    await expect(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    })).rejects.toThrow(/输出超过上限/);
  });

  it.each([
    ["claude", ["--permission-mode", "plan", "--no-session-persistence"]],
    ["grok", ["--permission-mode", "plan", "--tools", "Read,Glob,Grep", "--no-subagents", "--no-memory"]],
    ["pi", ["--no-approve", "--no-session", "--no-extensions", "--tools", "read,grep,find,ls"]],
    ["codebuddy", ["--permission-mode", "plan", "--strict-mcp-config"]],
    ["agy", ["--mode", "plan", "--sandbox"]],
  ] as const)("pins the %s read-only/non-persistent boundary", (adapter, required) => {
    const command = buildInvocationCommand(cli(adapter), preset, "prompt");
    for (const item of required) expect(command.args).toContain(item);
    expect(command.args).toContain("model-id");
  });

  it("keeps Reasonix bounded but does not claim project read-only support", () => {
    const command = buildInvocationCommand(cli("reasonix"), preset, "prompt");
    expect(command.args).toEqual(["run", "--dir", ".", "--model", "model-id", "--max-steps", "3"]);
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

  it("extracts only public assistant text from JSON and JSONL outputs", () => {
    expect(publicText(JSON.stringify({ type: "result", result: "final" }))).toBe("final");
    expect(publicText([
      JSON.stringify({ type: "progress", text: "internal progress" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
    ].join("\n"))).toContain("answer");
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

  it("classifies a non-zero generic CLI exit without exposing its secret", () => {
    const message = genericExitError("agy", 1, "token=fake-sensitive-token-123456").message;
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("fake-sensitive-token-123456");
  });
});
