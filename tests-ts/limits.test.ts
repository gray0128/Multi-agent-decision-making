import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, resolveLimits } from "../src/core/limits.js";

describe("three-layer resource limits", () => {
  it("defaults to five temporary participants", () => {
    expect(DEFAULT_LIMITS.maxParticipants).toBe(5);
  });

  it("persists an explicit global concurrency within the safe maximum", () => {
    expect(resolveLimits({ globalConcurrency: 3 }).globalConcurrency).toBe(3);
    expect(() => resolveLimits({ globalConcurrency: 99 })).toThrow(/globalConcurrency/);
  });

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
