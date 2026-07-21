import { describe, expect, it } from "vitest";
import { MadError } from "../src/core/errors.js";
import { parseCliRegistry, resolveInvocation } from "../src/adapters/config.js";

const valid = {
  defaults: { generator: { cli: "codex", preset: "deep" } },
  clis: [
    {
      id: "codex",
      adapter: "codex",
      executable: "codex",
      timeout_seconds: 120,
      max_concurrency: 1,
      presets: [
        {
          id: "deep",
          model: "gpt-test",
          context_budget: 64_000,
          options: { reasoning_effort: "high" },
        },
      ],
    },
  ],
};

describe("CLI registry", () => {
  it("parses a typed Codex invocation preset", () => {
    const registry = parseCliRegistry(valid);
    const { cli, preset } = resolveInvocation(registry, "codex", "deep");
    expect(cli.maxConcurrency).toBe(1);
    expect(preset.options.reasoningEffort).toBe("high");
  });

  it("rejects arbitrary pass-through arguments", () => {
    const unsafe = structuredClone(valid) as typeof valid & { clis: Array<(typeof valid.clis)[number] & { extra_args?: string[] }> };
    unsafe.clis[0]!.extra_args = ["--dangerously-bypass-approvals-and-sandbox"];
    expect(() => parseCliRegistry(unsafe)).toThrowError(/未知字段：extra_args/);
  });

  it("rejects unknown generator combinations", () => {
    const unknown = structuredClone(valid);
    unknown.defaults.generator.preset = "missing";
    expect(() => parseCliRegistry(unknown)).toThrowError(MadError);
  });

  it("rejects duplicate preset ids", () => {
    const duplicate = structuredClone(valid);
    duplicate.clis[0]!.presets.push(structuredClone(duplicate.clis[0]!.presets[0]!));
    expect(() => parseCliRegistry(duplicate)).toThrowError(/重复调用预设/);
  });

  it("rejects a preset context budget above the application safety maximum", () => {
    const oversized = structuredClone(valid);
    oversized.clis[0]!.presets[0]!.context_budget = 1_000_001;
    expect(() => parseCliRegistry(oversized)).toThrow(/context_budget.*1000000/);
  });

  it("does not treat the init template placeholder as a valid model", () => {
    const template = structuredClone(valid);
    template.clis[0]!.presets[0]!.model = "REPLACE_WITH_MODEL_ID";
    expect(() => parseCliRegistry(template)).toThrowError(/模板占位符/);
  });

  it("accepts only the reasoning option owned by each adapter", () => {
    const claude = structuredClone(valid) as unknown as Record<string, unknown>;
    const clis = claude.clis as Array<Record<string, unknown>>;
    clis[0]!.adapter = "claude";
    const presets = clis[0]!.presets as Array<Record<string, unknown>>;
    presets[0]!.options = { effort: "max" };
    expect(parseCliRegistry(claude).clis[0]!.presets[0]!.options.effort).toBe("max");
    presets[0]!.options = { thinking: "high" };
    expect(() => parseCliRegistry(claude)).toThrow(/未知字段：thinking/);
  });
});
