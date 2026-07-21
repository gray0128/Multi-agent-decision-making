import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliRegistry } from "../src/adapters/config.js";
import type { CliAdapter } from "../src/adapters/types.js";
import { ArchiveStore } from "../src/archive/store.js";
import { InvocationRunner } from "../src/core/execution.js";
import type { DeliberationManifest } from "../src/core/types.js";
import { MadError } from "../src/core/errors.js";

const registry: CliRegistry = {
  defaults: { generator: { cli: "codex", preset: "deep" } },
  clis: [{
    id: "codex", adapter: "codex", executable: "fake", timeoutSeconds: 30, maxConcurrency: 1,
    presets: [{ id: "deep", model: "fake", contextBudget: 64_000, options: {} }],
  }],
};

describe("InvocationRunner", () => {
  it("does not retry deterministic execution errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-execution-deterministic-"));
    const archive = new ArchiveStore(root, "d1");
    await archive.create({ schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "问题", mode: "structured", interaction: "auto" });
    const adapter: CliAdapter = {
      supportsProjectReadOnly: true, probe: vi.fn(), check: vi.fn(),
      invoke: vi.fn(async () => { throw new MadError("EXECUTION", "认证失败"); }),
    };
    const runner = new InvocationRunner(registry, archive, 20, process.cwd(), () => adapter);
    await expect(runner.run({
      id: "deterministic", kind: "contribution", agentId: "a", invocation: registry.defaults.generator,
      prompt: "prompt", stage: "independent",
    })).rejects.toThrow(/认证失败/);
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
  });

  it("retries a schema parse failure exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-execution-schema-"));
    const archive = new ArchiveStore(root, "d1");
    await archive.create({ schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "问题", mode: "structured", interaction: "auto" });
    const adapter: CliAdapter = {
      supportsProjectReadOnly: true, probe: vi.fn(), check: vi.fn(),
      invoke: vi.fn()
        .mockResolvedValueOnce({ text: "invalid", durationMs: 1, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } })
        .mockResolvedValueOnce({ text: '{"ok":true}', durationMs: 1, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } }),
    };
    const runner = new InvocationRunner(registry, archive, 20, process.cwd(), () => adapter);
    const output = await runner.run({
      id: "schema", kind: "contribution", agentId: "a", invocation: registry.defaults.generator,
      prompt: "prompt", stage: "revision", parse: (text) => JSON.parse(text) as { ok: boolean },
    });
    expect(output.value).toEqual({ ok: true });
    expect(adapter.invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized prompt before invoking the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-execution-context-"));
    const archive = new ArchiveStore(root, "d1");
    await archive.create({
      schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "问题",
      mode: "structured", interaction: "auto", planConfirmation: "auto-first-valid",
    });
    const adapter = { invoke: vi.fn() } as unknown as CliAdapter;
    const runner = new InvocationRunner(registry, archive, 20, process.cwd(), () => adapter);
    await expect(runner.run({
      id: "too-large", kind: "contribution", agentId: "a", invocation: registry.defaults.generator,
      prompt: "x".repeat(300_000), stage: "independent",
    })).rejects.toThrow(/上下文预算/);
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it("never returns or invokes a second result after the first result became authoritative", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-execution-authority-"));
    class FlakyDiagnosticStore extends ArchiveStore {
      private failDiagnostic = true;
      public override async appendDiagnostic(record: unknown): Promise<void> {
        if (this.failDiagnostic) {
          this.failDiagnostic = false;
          throw new Error("diagnostic disk failure");
        }
        await super.appendDiagnostic(record);
      }
    }
    const archive = new FlakyDiagnosticStore(root, "d1");
    const manifest: DeliberationManifest = {
      schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "问题",
      mode: "structured", interaction: "auto", planConfirmation: "auto-first-valid",
      plan: {
        organizer: registry.defaults.generator,
        participants: [
          { id: "a", invocation: registry.defaults.generator, role: "主张" },
          { id: "b", invocation: registry.defaults.generator, role: "审阅" },
        ],
        reportAgentId: "b",
        limits: { maxParticipants: 4, maxCalls: 20, maxDiscussionWindows: 2, timeoutSeconds: 30, contextBudget: 64_000 },
      },
    };
    await archive.create(manifest);
    let calls = 0;
    const adapter: CliAdapter = {
      supportsProjectReadOnly: true,
      probe: vi.fn(), check: vi.fn(),
      invoke: vi.fn(async () => {
        calls += 1;
        return { text: `answer-${calls}`, durationMs: 1, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } };
      }),
    };
    const runner = new InvocationRunner(registry, archive, 20, process.cwd(), () => adapter);
    const output = await runner.run({
      id: "call-1", kind: "contribution", agentId: "a", invocation: registry.defaults.generator,
      prompt: "frozen", stage: "independent",
    });
    expect(output.value).toBe("answer-1");
    expect(calls).toBe(1);
    expect((await archive.readState()).completedInvocations["call-1"]?.text).toBe("answer-1");
  });
});
