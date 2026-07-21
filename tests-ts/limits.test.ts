import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, resolveLimits } from "../src/core/limits.js";

describe("three-layer resource limits", () => {
  it("combines conservative defaults with per-run overrides", () => {
    expect(resolveLimits({ maxCalls: 75, timeoutSeconds: 600, contextBudget: 256_000 })).toEqual({
      ...DEFAULT_LIMITS,
      maxCalls: 75,
      timeoutSeconds: 600,
      contextBudget: 256_000,
    });
  });

  it("rejects values above ordinary-command safety maxima", () => {
    expect(() => resolveLimits({ maxParticipants: 9 })).toThrow(/1 到 8/);
    expect(() => resolveLimits({ timeoutSeconds: 1_801 })).toThrow(/1 到 1800/);
    expect(() => resolveLimits({ contextBudget: 1_000_001 })).toThrow(/1 到 1000000/);
  });
});
