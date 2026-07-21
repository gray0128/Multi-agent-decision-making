import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliRegistry } from "../src/adapters/config.js";
import type { CliAdapter } from "../src/adapters/types.js";
import { ArchiveStore } from "../src/archive/store.js";
import { DiscussionController } from "../src/core/discussion.js";
import { InvocationRunner } from "../src/core/execution.js";
import type { DeliberationManifest, DeliberationPlan } from "../src/core/types.js";

const registry: CliRegistry = {
  defaults: { generator: { cli: "codex", preset: "deep" } },
  clis: [{
    id: "codex", adapter: "codex", executable: "fake", timeoutSeconds: 30, maxConcurrency: 1,
    presets: [{ id: "deep", model: "fake", contextBudget: 64_000, options: {} }],
  }],
};

const plan: DeliberationPlan = {
  organizer: { cli: "codex", preset: "deep" },
  participants: [
    { id: "host", invocation: { cli: "codex", preset: "deep" }, role: "主持兼方案主张" },
    { id: "critic", invocation: { cli: "codex", preset: "deep" }, role: "风险审阅" },
  ],
  reportAgentId: "critic",
  moderatorAgentId: "host",
  limits: { maxParticipants: 4, maxCalls: 40, maxDiscussionWindows: 3, timeoutSeconds: 300, contextBudget: 64_000 },
};

describe("DiscussionController", () => {
  it("runs coverage, non-consecutive windows, convergence, and the shared outcome pipeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-discussion-"));
    const archive = new ArchiveStore(root, "d1");
    const manifest: DeliberationManifest = {
      schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "选择方案",
      mode: "free", interaction: "auto", plan, planConfirmation: "auto-first-valid",
    };
    await archive.create(manifest);
    let evaluations = 0;
    const prompts: string[] = [];
    const adapter: CliAdapter = {
      supportsProjectReadOnly: true,
      probe: vi.fn(async () => ({ ready: true })),
      check: vi.fn(async () => ({ ready: true })),
      invoke: vi.fn(async ({ prompt }) => {
        prompts.push(prompt);
        let text = "参与者发言";
        if (prompt.includes("规划覆盖周期")) text = JSON.stringify({ order: ["host", "critic"] });
        else if (prompt.includes("评估是否已充分收敛")) {
          evaluations += 1;
          text = evaluations === 1
            ? JSON.stringify({ speakers: ["host", "critic"], converged: false, rationale: "仍需核对风险" })
            : JSON.stringify({ speakers: [], converged: true, rationale: "关键风险已明确" });
        } else if (prompt.includes("生成 Markdown 草稿")) text = "# 自由讨论草稿";
        else if (prompt.includes("完成一次最终修订")) text = "# 自由讨论最终报告\n## 共识\n审计。\n## 未决争议\n节奏。\n## 假设\n工具可用。\n## 风险\n预算。";
        return { text, durationMs: 1, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } };
      }),
    };
    const runner = new InvocationRunner(registry, archive, plan.limits.maxCalls, process.cwd(), () => adapter);
    const result = await new DiscussionController(registry, archive, plan, process.cwd(), undefined, runner).run("选择方案");
    expect(result).toMatchObject({ rounds: 4, windows: 1, converged: true, callAttempts: 10 });
    expect(result.report).toContain("最终报告");
    const draftPrompt = prompts.find((prompt) => prompt.includes("生成 Markdown 草稿"));
    expect(draftPrompt).toContain("主持调度不作为参与者观点");
    expect(draftPrompt).not.toContain("仍需核对风险");
  });
});
