import { describe, expect, it } from "vitest";
import * as TOML from "@iarna/toml";
import { buildConfigTemplate, parseCliRegistry } from "../src/adapters/config.js";

describe("mad init template", () => {
  it("lists detected CLIs without guessing a default generator or model", () => {
    const template = buildConfigTemplate(["codex", "claude", "pi"]);
    const parsed = TOML.parse(template) as unknown as Record<string, unknown>;
    expect(template).toContain('cli = "REPLACE_WITH_CLI_ID"');
    expect(template).toContain('model = "REPLACE_WITH_MODEL_ID"');
    expect((parsed.clis as unknown[])).toHaveLength(3);
    expect(() => parseCliRegistry(parsed)).toThrow();
  });

  it("still creates an editable TOML skeleton when no CLI is installed", () => {
    const parsed = TOML.parse(buildConfigTemplate([])) as unknown as Record<string, unknown>;
    expect(parsed.clis).toEqual([]);
  });

  it("records the detected executable path without changing the trusted adapter id", () => {
    const template = buildConfigTemplate(["codex"], { codex: "/opt/tools/codex" });
    expect(template).toContain('adapter = "codex"');
    expect(template).toContain('executable = "/opt/tools/codex"');
  });
});
