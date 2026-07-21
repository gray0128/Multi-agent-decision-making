import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliRegistry } from "../src/adapters/config.js";
import type { CliAdapter } from "../src/adapters/types.js";
import { ArchiveStore } from "../src/archive/store.js";
import { SharedContextManager } from "../src/core/context.js";
import { InvocationRunner } from "../src/core/execution.js";
import type { DeliberationManifest, DeliberationPlan } from "../src/core/types.js";

describe("SharedContextManager", () => {
  it("generates one shared rolling summary and keeps recent records after it", async () => {
    const registry: CliRegistry = {
      defaults: { generator: { cli: "codex", preset: "tiny" } },
      clis: [{
        id: "codex", adapter: "codex", executable: "fake", timeoutSeconds: 30, maxConcurrency: 1,
        presets: [{ id: "tiny", model: "fake", contextBudget: 100, options: {} }],
      }],
    };
    const plan: DeliberationPlan = {
      organizer: registry.defaults.generator,
      participants: [
        { id: "a", invocation: registry.defaults.generator, role: "主张" },
        { id: "b", invocation: registry.defaults.generator, role: "报告" },
      ],
      reportAgentId: "b",
      limits: { maxParticipants: 4, maxCalls: 20, maxDiscussionWindows: 2, timeoutSeconds: 300, contextBudget: 100 },
    };
    const root = await mkdtemp(join(tmpdir(), "mad-context-"));
    const archive = new ArchiveStore(root, "d1");
    const manifest: DeliberationManifest = {
      schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "问题",
      mode: "structured", interaction: "auto", plan, planConfirmation: "auto-first-valid",
    };
    await archive.create(manifest);
    const adapter: CliAdapter = {
      supportsProjectReadOnly: true,
      probe: vi.fn(), check: vi.fn(),
      invoke: vi.fn(async () => ({ text: "保留 A 与 B 的分歧", durationMs: 1, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } })),
    };
    const runner = new InvocationRunner(registry, archive, 20, process.cwd(), () => adapter);
    const context = new SharedContextManager(registry, runner, plan);
    context.add("A", "甲".repeat(300));
    context.add("B", "乙".repeat(300));
    const summarized = await context.snapshot("问题");
    expect(summarized).toContain("统一滚动摘要");
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    context.add("最近发言", "新增证据");
    const withRecent = await context.snapshot("问题");
    expect(withRecent).toContain("摘要后的最近权威记录");
    expect(withRecent).toContain("新增证据");
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
  });
});
