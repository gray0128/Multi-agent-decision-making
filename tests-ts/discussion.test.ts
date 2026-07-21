import { mkdtemp, readFile } from "node:fs/promises";
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
  it("lets a guided user continue after the moderator reports convergence", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-discussion-override-"));
    const archive = new ArchiveStore(root, "d1");
    await archive.create({
      schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "继续讨论",
      mode: "free", interaction: "guided", plan, planConfirmation: "interactive",
    });
    let evaluations = 0;
    const adapter: CliAdapter = {
      projectReadOnlyCapability: "runtime-canary", verifyProjectReadOnly: vi.fn(async () => ({ verified: true })),
      probe: vi.fn(), check: vi.fn(),
      invoke: vi.fn(async ({ prompt }) => {
        let text = "参与者发言";
        if (prompt.includes("规划覆盖周期")) text = JSON.stringify({ order: ["host", "critic"] });
        else if (prompt.includes("评估是否已充分收敛")) {
          evaluations += 1;
          text = evaluations === 1
            ? JSON.stringify({ speakers: ["host", "critic"], converged: true, rationale: "主持建议结束" })
            : JSON.stringify({ speakers: [], converged: true, rationale: "用户要求的补充已完成" });
        } else if (prompt.includes("生成 Markdown 草稿")) text = "# 草稿";
        else if (prompt.includes("完成一次最终修订")) text = "# 最终报告\n## 共识\n完成。\n## 未决争议\n无。\n## 假设\n有效。\n## 风险\n低。";
        return { text, durationMs: 1, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } };
      }),
    };
    const checkpoint = vi.fn(async (window: number) => ({ action: window === 0 ? "continue" as const : "end" as const }));
    const runner = new InvocationRunner(registry, archive, plan.limits.maxCalls, process.cwd(), () => adapter);
    const result = await new DiscussionController(registry, archive, plan, process.cwd(), checkpoint, runner).run("继续讨论");
    expect(result.rounds).toBe(4);
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });

  it("offers a guided checkpoint after the final allowed discussion window", async () => {
    const oneWindowPlan: DeliberationPlan = { ...plan, limits: { ...plan.limits, maxDiscussionWindows: 1 } };
    const root = await mkdtemp(join(tmpdir(), "mad-discussion-final-boundary-"));
    const archive = new ArchiveStore(root, "d1");
    await archive.create({
      schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "窗口上限",
      mode: "free", interaction: "guided", plan: oneWindowPlan, planConfirmation: "interactive",
    });
    const adapter: CliAdapter = {
      projectReadOnlyCapability: "runtime-canary", verifyProjectReadOnly: vi.fn(async () => ({ verified: true })),
      probe: vi.fn(), check: vi.fn(),
      invoke: vi.fn(async ({ prompt }) => {
        let text = "参与者发言";
        if (prompt.includes("规划覆盖周期")) text = JSON.stringify({ order: ["host", "critic"] });
        else if (prompt.includes("评估是否已充分收敛")) text = JSON.stringify({ speakers: ["host", "critic"], converged: false, rationale: "仍有分歧" });
        else if (prompt.includes("生成 Markdown 草稿")) text = "# 草稿";
        else if (prompt.includes("完成一次最终修订")) text = "# 最终报告\n## 共识\n部分。\n## 未决争议\n仍有。\n## 假设\n有效。\n## 风险\n中。";
        return { text, durationMs: 1, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } };
      }),
    };
    const checkpoint = vi.fn(async (window: number) => ({ action: window === 0 ? "continue" as const : "end" as const }));
    const runner = new InvocationRunner(registry, archive, oneWindowPlan.limits.maxCalls, process.cwd(), () => adapter);
    await new DiscussionController(registry, archive, oneWindowPlan, process.cwd(), checkpoint, runner).run("窗口上限");
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });

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
      projectReadOnlyCapability: "runtime-canary",
      verifyProjectReadOnly: vi.fn(async () => ({ verified: true })),
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

  it("records when automatic discussion stops at the window limit", async () => {
    const limitedPlan: DeliberationPlan = { ...plan, limits: { ...plan.limits, maxDiscussionWindows: 1 } };
    const root = await mkdtemp(join(tmpdir(), "mad-discussion-end-reason-"));
    const archive = new ArchiveStore(root, "d1");
    await archive.create({
      schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "窗口上限",
      mode: "free", interaction: "auto", plan: limitedPlan, planConfirmation: "auto-first-valid",
    });
    const adapter: CliAdapter = {
      projectReadOnlyCapability: "runtime-canary",
      verifyProjectReadOnly: vi.fn(async () => ({ verified: true })),
      probe: vi.fn(), check: vi.fn(),
      invoke: vi.fn(async ({ prompt }) => {
        let text = "参与者发言";
        if (prompt.includes("规划覆盖周期")) text = JSON.stringify({ order: ["host", "critic"] });
        else if (prompt.includes("评估是否已充分收敛")) {
          text = JSON.stringify({ speakers: ["host", "critic"], converged: false, rationale: "仍有分歧" });
        } else if (prompt.includes("生成 Markdown 草稿")) text = "# 草稿";
        else if (prompt.includes("完成一次最终修订")) {
          text = "# 最终报告\n## 共识\n部分。\n## 未决争议\n仍有。\n## 假设\n有效。\n## 风险\n中。";
        }
        return { text, durationMs: 1, diagnostic: { executable: "fake", exitCode: 0, stderr: "" } };
      }),
    };

    const runner = new InvocationRunner(registry, archive, limitedPlan.limits.maxCalls, process.cwd(), () => adapter);
    await new DiscussionController(registry, archive, limitedPlan, process.cwd(), undefined, runner).run("窗口上限");

    const events = (await readFile(join(archive.path, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: { endReason?: string } });
    expect(events).toContainEqual(expect.objectContaining({
      type: "discussion.ended",
      data: expect.objectContaining({ endReason: "max_windows" }),
    }));
  });

  it("records a guided cancellation as an unrecoverable end reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "mad-discussion-cancel-"));
    const archive = new ArchiveStore(root, "d1");
    await archive.create({
      schemaVersion: 1, id: "d1", createdAt: new Date().toISOString(), question: "取消讨论",
      mode: "free", interaction: "guided", plan, planConfirmation: "interactive",
    });
    const adapter: CliAdapter = {
      projectReadOnlyCapability: "runtime-canary",
      verifyProjectReadOnly: vi.fn(async () => ({ verified: true })),
      probe: vi.fn(), check: vi.fn(),
      invoke: vi.fn(async ({ prompt }) => ({
        text: prompt.includes("规划覆盖周期")
          ? JSON.stringify({ order: ["host", "critic"] })
          : prompt.includes("评估是否已充分收敛")
            ? JSON.stringify({ speakers: ["host", "critic"], converged: false, rationale: "仍有分歧" })
            : "参与者发言",
        durationMs: 1,
        diagnostic: { executable: "fake", exitCode: 0, stderr: "" },
      })),
    };
    const runner = new InvocationRunner(registry, archive, plan.limits.maxCalls, process.cwd(), () => adapter);

    await expect(new DiscussionController(
      registry,
      archive,
      plan,
      process.cwd(),
      async () => ({ action: "cancel" }),
      runner,
    ).run("取消讨论")).rejects.toThrow(/取消/);

    expect((await archive.readState()).status).toBe("cancelled");
    const events = await readFile(join(archive.path, "events.jsonl"), "utf8");
    expect(events).toContain('"endReason":"cancelled"');
  });
});
