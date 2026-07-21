import type { ResourceLimits } from "./types.js";
import { MadError } from "./errors.js";

export const DEFAULT_LIMITS: ResourceLimits = {
  maxParticipants: 4,
  maxCalls: 60,
  maxDiscussionWindows: 6,
  timeoutSeconds: 300,
  contextBudget: 128_000,
};

export const SAFE_MAX_LIMITS: ResourceLimits = {
  maxParticipants: 8,
  maxCalls: 100,
  maxDiscussionWindows: 12,
  timeoutSeconds: 1_800,
  contextBudget: 1_000_000,
};

export function resolveLimits(overrides: Partial<ResourceLimits> = {}): ResourceLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, maximum] of Object.entries(SAFE_MAX_LIMITS) as [keyof ResourceLimits, number][]) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new MadError("USAGE", `${key} 必须是 1 到 ${maximum} 之间的整数`);
    }
  }
  return limits;
}
