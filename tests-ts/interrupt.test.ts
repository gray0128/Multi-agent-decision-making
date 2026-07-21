import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliRegistry } from "../src/adapters/config.js";
import type { CliAdapter } from "../src/adapters/types.js";
import { ArchiveStore } from "../src/archive/store.js";
import { MadError } from "../src/core/errors.js";
import { InvocationRunner } from "../src/core/execution.js";
import type { DeliberationManifest } from "../src/core/types.js";

describe("interrupt recovery boundary", () => {
  it("aborts the active CLI attempt and preserves the frozen logical call", async () => {
    const registry: CliRegistry = {
      defaults: { generator: { cli: "codex", preset: "deep" } },
      clis: [{ id: "codex", adapter: "codex", executable: "fake", timeoutSeconds: 30, maxConcurrency: 1,
        presets: [{ id: "deep", model: "fake", contextBudget: 64_000, options: {} }] }],
    };
    const plan = {
      organizer: registry.defaults.generator,
      participants: [
        { id: "a", invocation: registry.defaults.generator, role: "主张" },
        { id: "b", invocation: registry.defaults.generator, role: "报告" },
      ],
      reportAgentId: "b",
      limits: { maxParticipants: 4, maxCalls: 20, maxDiscussionWindows: 2, timeoutSeconds: 300, contextBudget: 64_000 },
    } as const;
    const root = await mkdtemp(join(tmpdir(), "mad-interrupt-"));
    const archive = new ArchiveStore(root, "d1");
    const manifest: DeliberationManifest = {
      schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "问题",
      mode: "structured", interaction: "auto", plan, planConfirmation: "auto-first-valid",
    };
    await archive.create(manifest);
    const adapter: CliAdapter = {
      supportsProjectReadOnly: true, probe: vi.fn(), check: vi.fn(),
      invoke: vi.fn(({ signal }) => new Promise<never>((_, reject) => {
        if (signal?.aborted) return reject(new MadError("PAUSED", "已中止"));
        signal?.addEventListener("abort", () => reject(new MadError("PAUSED", "已中止")), { once: true });
      })),
    };
    const abort = new AbortController();
    const runner = new InvocationRunner(registry, archive, 20, process.cwd(), () => adapter);
    runner.setSignal(abort.signal);
    const running = runner.run({
      id: "call-1", kind: "contribution", agentId: "a", invocation: registry.defaults.generator,
      stage: "independent", prompt: "frozen prompt",
    });
    setTimeout(() => abort.abort(), 5);
    await expect(running).rejects.toMatchObject({ code: "PAUSED" });
    const state = await archive.readState();
    expect(state.pendingInvocations["call-1"]?.prompt).toBe("frozen prompt");
    expect(state.completedInvocations["call-1"]).toBeUndefined();
  });
});
