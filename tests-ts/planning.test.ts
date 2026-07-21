import { describe, expect, it, vi } from "vitest";
import type { CliAdapter } from "../src/adapters/types.js";
import type { CliRegistry } from "../src/adapters/config.js";
import { OrganizerService, parseDeliberationPlan } from "../src/core/planning.js";
import { DEFAULT_LIMITS } from "../src/core/limits.js";

const registry: CliRegistry = {
  defaults: { generator: { cli: "codex", preset: "deep" } },
  clis: [{
    id: "codex",
    adapter: "codex",
    executable: "codex",
    timeoutSeconds: 300,
    maxConcurrency: 1,
    presets: [{ id: "deep", model: "gpt-test", contextBudget: 64_000, options: { reasoningEffort: "high" } }],
  }],
};

const structuredPayload = JSON.stringify({
  participants: [
    { id: "architect", cli: "codex", preset: "deep", role: "提出架构方案" },
    { id: "reviewer", cli: "codex", preset: "deep", role: "审阅风险" },
  ],
  report_agent_id: "reviewer",
});

describe("fixed organizer", () => {
  it("parses generated instances while preserving shared invocation origin", () => {
    const plan = parseDeliberationPlan(structuredPayload, {
      registry,
      mode: "structured",
      limits: DEFAULT_LIMITS,
      organizer: registry.defaults.generator,
    });
    expect(plan.participants).toHaveLength(2);
    expect(plan.participants[0]!.invocation).toEqual(plan.participants[1]!.invocation);
    expect(plan.limits.contextBudget).toBe(64_000);
  });

  it("requires a participating moderator in free mode", () => {
    expect(() => parseDeliberationPlan(structuredPayload, {
      registry,
      mode: "free",
      limits: DEFAULT_LIMITS,
      organizer: registry.defaults.generator,
    })).toThrow(/moderator_agent_id/);
  });

  it("rejects fields that could escape the trusted registry", () => {
    const payload = JSON.parse(structuredPayload) as Record<string, unknown>;
    (payload.participants as Array<Record<string, unknown>>)[0]!.model = "raw-model";
    expect(() => parseDeliberationPlan(payload, {
      registry,
      mode: "structured",
      limits: DEFAULT_LIMITS,
      organizer: registry.defaults.generator,
    })).toThrow(/禁止字段：model/);
  });

  it("preflights each unique invocation combination only once", async () => {
    const adapter: CliAdapter = {
      supportsProjectReadOnly: true,
      probe: vi.fn(async () => ({ ready: true })),
      check: vi.fn(async () => ({ ready: true })),
      invoke: vi.fn(async () => ({
        text: structuredPayload,
        durationMs: 1,
        diagnostic: { executable: "fake", exitCode: 0, stderr: "" },
      })),
    };
    const factory = vi.fn(() => adapter);
    const result = await new OrganizerService(registry, factory).propose({
      question: "如何迁移？",
      mode: "structured",
      limits: DEFAULT_LIMITS,
      cwd: process.cwd(),
    });
    expect(result.preflightedCombinations).toEqual(["codex/deep"]);
    expect(adapter.check).toHaveBeenCalledTimes(2); // 组局器一次，方案中的唯一组合一次
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("blocks an adapter without proven read-only mode from project deliberation", async () => {
    const reasonixRegistry: CliRegistry = {
      defaults: registry.defaults,
      clis: [...registry.clis, {
        id: "reasonix", adapter: "reasonix", executable: "reasonix", timeoutSeconds: 30, maxConcurrency: 1,
        presets: [{ id: "deep", model: "reasonix-model", contextBudget: 64_000, options: {} }],
      }],
    };
    const plan = parseDeliberationPlan(JSON.stringify({
      participants: [
        { id: "a", cli: "reasonix", preset: "deep", role: "主张" },
        { id: "b", cli: "codex", preset: "deep", role: "审阅" },
      ],
      report_agent_id: "b",
    }), { registry: reasonixRegistry, mode: "structured", limits: DEFAULT_LIMITS, organizer: registry.defaults.generator });
    const adapter = { supportsProjectReadOnly: false, probe: vi.fn(), check: vi.fn(), invoke: vi.fn() } as unknown as CliAdapter;
    await expect(new OrganizerService(reasonixRegistry, () => adapter).preflightPlan(plan, process.cwd(), undefined, true))
      .rejects.toThrow(/禁止项目模式/);
  });
});
