import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliRegistry } from "../src/adapters/config.js";
import type { CliAdapter } from "../src/adapters/types.js";
import { ArchiveStore } from "../src/archive/store.js";
import { InvocationRunner } from "../src/core/execution.js";
import { StructuredController } from "../src/core/structured.js";
import type { DeliberationManifest, DeliberationPlan } from "../src/core/types.js";

const registry: CliRegistry = {
  defaults: { generator: { cli: "codex", preset: "deep" } },
  clis: [{
    id: "codex",
    adapter: "codex",
    executable: "fake",
    timeoutSeconds: 30,
    maxConcurrency: 1,
    presets: [{ id: "deep", model: "fake", contextBudget: 64_000, options: {} }],
  }],
};

const plan: DeliberationPlan = {
  organizer: { cli: "codex", preset: "deep" },
  participants: [
    { id: "architect", invocation: { cli: "codex", preset: "deep" }, role: "架构主张者" },
    { id: "reviewer", invocation: { cli: "codex", preset: "deep" }, role: "风险审阅者" },
  ],
  reportAgentId: "reviewer",
  limits: { maxParticipants: 4, maxCalls: 40, maxDiscussionWindows: 6, timeoutSeconds: 300, contextBudget: 64_000 },
};

function manifest(id: string): DeliberationManifest {
  return {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    question: "迁移方案",
    mode: "structured",
    interaction: "auto",
    plan,
    planConfirmation: "auto-first-valid",
  };
}

describe("StructuredController", () => {
  it("waits for sibling calls to settle before a parallel stage fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-structured-settle-"));
    const archive = new ArchiveStore(root, "d1");
    const concurrentRegistry: CliRegistry = {
      ...registry,
      clis: [{ ...registry.clis[0]!, maxConcurrency: 2 }],
    };
    await archive.create(manifest("d1"));
    let slowFinished = false;
    const adapter: CliAdapter = {
      supportsProjectReadOnly: true,
      probe: vi.fn(),
      check: vi.fn(),
      invoke: vi.fn(async ({ prompt }) => {
        if (prompt.includes("architect")) throw new Error("fast failure");
        await new Promise((resolve) => setTimeout(resolve, 50));
        slowFinished = true;
        return { text: "slow result", durationMs: 50, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } };
      }),
    };
    const runner = new InvocationRunner(concurrentRegistry, archive, plan.limits.maxCalls, process.cwd(), () => adapter);
    const controller = new StructuredController(concurrentRegistry, archive, plan, process.cwd(), undefined, runner);
    await expect(controller.run("迁移方案")).rejects.toThrow(/连续两次失败/);
    expect(slowFinished).toBe(true);
  });

  it("runs barriers, one convergence round, review, and final revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-structured-"));
    const archive = new ArchiveStore(root, "d1");
    await archive.create(manifest("d1"));
    let active = 0;
    let maximumActive = 0;
    const prompts: string[] = [];
    const adapter: CliAdapter = {
      supportsProjectReadOnly: true,
      probe: vi.fn(async () => ({ ready: true })),
      check: vi.fn(async () => ({ ready: true })),
      invoke: vi.fn(async ({ prompt }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        prompts.push(prompt);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        let text = "阶段输出";
        if (prompt.includes("只输出 JSON")) {
          const stance = prompt.includes("你是 architect") ? "立即迁移" : "延后迁移";
          text = JSON.stringify({ position: stance, disputes: [{ topic: "迁移时机", stance, confidence: "high" }] });
        } else if (prompt.includes("完成一次最终修订")) text = "# 最终报告\n\n## 共识\n保留审计记录。\n\n## 未决争议\n迁移时机。\n\n## 假设\n工具可用。\n\n## 风险\n预算不足。";
        else if (prompt.includes("生成 Markdown 草稿")) text = "# 草稿";
        return { text, durationMs: 1, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } };
      }),
    };
    const runner = new InvocationRunner(registry, archive, plan.limits.maxCalls, process.cwd(), () => adapter);
    const checkpoint = vi.fn(async (stage: string) => ({
      action: "continue" as const,
      ...(stage === "draft" ? { guidance: "最终报告必须列出回滚步骤" } : {}),
    }));
    const controller = new StructuredController(registry, archive, plan, process.cwd(), checkpoint, runner);
    const result = await controller.run("迁移方案");
    expect(result.report).toContain("最终报告");
    expect(result.disputes).toEqual(["迁移时机"]);
    expect(result.callAttempts).toBe(11);
    expect(maximumActive).toBe(1); // 同一 CLI 的所有角色和预设共享限流器
    expect(prompts.some((prompt) => prompt.includes("不得把这些角色的一致意见描述为独立模型交叉验证"))).toBe(true);
    const reviewPrompt = prompts.find((prompt) => prompt.includes("检查是否忠实反映"));
    expect(reviewPrompt).toContain("独立陈述");
    const finalPrompt = prompts.find((prompt) => prompt.includes("完成一次最终修订"));
    expect(finalPrompt).toContain("最终报告必须列出回滚步骤");
    const transcript = (await readFile(join(archive.path, "transcript.jsonl"), "utf8")).trim().split("\n");
    expect(transcript).toHaveLength(11);

    const resumed = await controller.run("迁移方案");
    expect(resumed.callAttempts).toBe(11);
    expect(adapter.invoke).toHaveBeenCalledTimes(11);
    expect(checkpoint).toHaveBeenCalledTimes(4);
  });
});
