import type { ArchiveStore } from "../archive/store.js";
import type { DeliberationMode, DeliberationPlan } from "../core/types.js";

export async function emitWarnings(
  archive: ArchiveStore,
  warnings: readonly string[],
  resumed = false,
): Promise<void> {
  for (const warning of warnings) {
    process.stderr.write(`警告：${warning}\n`);
    await archive.appendEvent("warning", { message: warning, ...(resumed ? { resumed: true } : {}) });
  }
}

export function writeCompletedResult(options: {
  readonly format: "markdown" | "json";
  readonly deliberationId: string;
  readonly mode: DeliberationMode;
  readonly result: { readonly report: string; readonly callAttempts: number };
  readonly plan: DeliberationPlan;
  readonly warnings: readonly string[];
  readonly archivePath: string;
}): void {
  if (options.format === "markdown") {
    process.stdout.write(`${options.result.report}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    deliberation_id: options.deliberationId,
    status: "completed",
    mode: options.mode,
    report: options.result.report,
    participants: options.plan.participants,
    budget_usage: {
      call_attempts: options.result.callAttempts,
      max_calls: options.plan.limits.maxCalls,
      timeout_seconds: options.plan.limits.timeoutSeconds,
      context_budget: options.plan.limits.contextBudget,
      global_concurrency: options.plan.limits.globalConcurrency ?? 6,
    },
    warnings: options.warnings,
    archive_path: options.archivePath,
  })}\n`);
}
