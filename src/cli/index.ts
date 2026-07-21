#!/usr/bin/env node
import { parseArgs } from "node:util";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { createAdapter } from "../adapters/index.js";
import {
  ADAPTER_IDS,
  buildConfigTemplate,
  loadCliRegistry,
  resolveInvocation,
  type AdapterId,
  type CliRegistry,
} from "../adapters/config.js";
import { runProcess } from "../adapters/process.js";
import { buildProbeCommand } from "../adapters/generic.js";
import { EXIT_CODES, MadError } from "../core/errors.js";
import { appPaths } from "../core/paths.js";
import { resolveLimits } from "../core/limits.js";
import { OrganizerService, parseDeliberationPlan } from "../core/planning.js";
import { StructuredController, type CheckpointHandler } from "../core/structured.js";
import { DiscussionController, type DiscussionCheckpoint } from "../core/discussion.js";
import { sharedOriginWarning } from "../core/outcome.js";
import { InvocationRunner } from "../core/execution.js";
import { ActiveDeliberationLock, ArchiveStore } from "../archive/store.js";
import type {
  DeliberationManifest,
  DeliberationMode,
  DeliberationPlan,
  InteractionPolicy,
  InvocationConfigSnapshot,
  InvocationPresetRef,
} from "../core/types.js";
import { CheckpointMailbox, observerIsOnline, startObserverServer } from "../server/index.js";
import { emitWarnings, writeCompletedResult } from "./output.js";

const HELP = `mad - 本地多 Agent 审议工具（TypeScript 迁移版）

用法：
  mad init [--force]
  mad config validate
  mad config check
  mad deliberate "问题" [--mode structured|free] [--workspace PATH]
                 [--auto] [--auto-confirm-plan] [--format markdown|json]
                 [--max-participants N] [--max-calls N] [--max-discussion-windows N]
                 [--timeout-seconds N] [--context-budget N] [--global-concurrency N]
  mad resume ID [--format markdown|json]
  mad serve [--port PORT]
  mad --help
`;

async function initialize(force: boolean): Promise<void> {
  const paths = appPaths();
  await Promise.all([
    ensurePrivateDirectory(paths.home),
    ensurePrivateDirectory(dirname(paths.config)),
    ensurePrivateDirectory(paths.deliberations),
    ensurePrivateDirectory(paths.runtime),
  ]);
  const executablePaths: Partial<Record<AdapterId, string>> = {};
  const installedResults = await Promise.all(ADAPTER_IDS.map(async (adapter) => {
    try {
      const executable = await findExecutable(adapter);
      if (!executable) return null;
      const probe = adapter === "codex" ? ["--version"] : buildProbeCommand(adapter);
      const result = await runProcess(executable, probe, { cwd: process.cwd(), timeoutMs: 5_000 });
      if (result.exitCode !== 0) return null;
      executablePaths[adapter] = executable;
      return adapter;
    } catch { return null; }
  }));
  const installed = installedResults.filter((value): value is AdapterId => value !== null);
  try {
    await writeFile(paths.config, buildConfigTemplate(installed, executablePaths), {
      encoding: "utf8",
      mode: 0o600,
      flag: force ? "w" : "wx",
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new MadError("CONFIG", `配置已存在：${paths.config}（使用 --force 显式重建）`);
    throw error;
  }
  await chmod(paths.config, 0o600);
  process.stderr.write(`已创建配置骨架：${paths.config}\n探测到 CLI：${installed.join(", ") || "无"}\n请填写默认组局器与真实 model 后运行 mad config validate。\n`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function findExecutable(name: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* try next PATH entry */ }
  }
  return null;
}

async function validateConfig(check: boolean): Promise<void> {
  const paths = appPaths();
  const registry = await loadCliRegistry(paths.config);
  if (check) {
    const combinations = registry.clis.flatMap((cli) => cli.presets.map((preset) => ({ cli, preset })));
    for (const combination of combinations) {
      process.stderr.write(`预检 ${combination.cli.id}/${combination.preset.id} ...\n`);
      const result = await createAdapter(combination.cli, combination.preset).check(process.cwd());
      if (!result.ready) {
        throw new MadError(
          "PREFLIGHT",
          `${combination.cli.id}/${combination.preset.id} 预检失败：${result.detail ?? "未知错误"}`,
        );
      }
    }
    process.stdout.write(`配置有效，${combinations.length} 个调用组合预检通过。\n`);
    return;
  }
  const generator = resolveInvocation(registry, registry.defaults.generator.cli, registry.defaults.generator.preset);
  process.stdout.write(`配置有效：${registry.clis.length} 个 CLI；默认组局器 ${generator.cli.id}/${generator.preset.id}。\n`);
}

function externalPlan(plan: DeliberationPlan): Record<string, unknown> {
  return {
    participants: plan.participants.map((participant) => ({
      id: participant.id,
      cli: participant.invocation.cli,
      preset: participant.invocation.preset,
      role: participant.role,
    })),
    report_agent_id: plan.reportAgentId,
    ...(plan.moderatorAgentId ? { moderator_agent_id: plan.moderatorAgentId } : {}),
  };
}

function snapshotRegistry(registry: CliRegistry, plan?: DeliberationPlan): InvocationConfigSnapshot[] {
  const references = plan
    ? [plan.organizer, ...plan.participants.map((participant) => participant.invocation)]
    : registry.clis.flatMap((cli) => cli.presets.map((preset) => ({ cli: cli.id, preset: preset.id })));
  const unique = new Map(references.map((reference) => [`${reference.cli}/${reference.preset}`, reference]));
  return [...unique.values()].map((reference) => {
    const { cli, preset } = resolveInvocation(registry, reference.cli, reference.preset);
    return {
      cli: cli.id,
      preset: preset.id,
      adapter: cli.adapter,
      executable: cli.executable,
      timeoutSeconds: cli.timeoutSeconds,
      maxConcurrency: cli.maxConcurrency,
      model: preset.model,
      contextBudget: preset.contextBudget,
      options: preset.options,
    };
  });
}

function registryFromManifest(manifest: DeliberationManifest): CliRegistry | null {
  if (!manifest.registrySnapshot?.length) return null;
  const clis = new Map<string, CliRegistry["clis"][number]>();
  for (const snapshot of manifest.registrySnapshot) {
    const existing = clis.get(snapshot.cli);
    const preset = {
      id: snapshot.preset,
      model: snapshot.model,
      contextBudget: snapshot.contextBudget,
      options: snapshot.options,
    };
    if (existing) {
      if (
        existing.adapter !== snapshot.adapter ||
        existing.executable !== snapshot.executable ||
        existing.timeoutSeconds !== snapshot.timeoutSeconds ||
        existing.maxConcurrency !== snapshot.maxConcurrency
      ) throw new MadError("CONFIG", `档案中的 CLI 快照不一致：${snapshot.cli}`);
      clis.set(snapshot.cli, { ...existing, presets: [...existing.presets, preset] });
    } else {
      clis.set(snapshot.cli, {
        id: snapshot.cli,
        adapter: snapshot.adapter,
        executable: snapshot.executable,
        timeoutSeconds: snapshot.timeoutSeconds,
        maxConcurrency: snapshot.maxConcurrency,
        presets: [preset],
      });
    }
  }
  const organizer = manifest.plan?.organizer ?? manifest.planning?.organizer;
  if (!organizer) throw new MadError("CONFIG", "档案缺少组局器快照");
  return { defaults: { generator: organizer }, clis: [...clis.values()] };
}

async function confirmPlan(
  initial: DeliberationPlan,
  organizerService: OrganizerService,
  context: {
    readonly registry: Awaited<ReturnType<typeof loadCliRegistry>>;
    readonly question: string;
    readonly mode: DeliberationMode;
    readonly limits: ReturnType<typeof resolveLimits>;
    readonly organizer: InvocationPresetRef;
    readonly cwd: string;
    readonly projectMode: boolean;
    readonly signal?: AbortSignal;
    readonly initialGeneration?: number;
    readonly onCandidate?: (plan: DeliberationPlan, generation: number) => Promise<void>;
  },
): Promise<DeliberationPlan> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  let plan = initial;
  let generation = context.initialGeneration ?? 0;
  try {
    while (true) {
      process.stderr.write(`最终审议方案：\n${JSON.stringify(externalPlan(plan), null, 2)}\n`);
      let answer: string;
      try {
        const prompt = "回车确认；输入完整 JSON 修改；/regroup 指导 重新组局；/cancel 取消：";
        answer = (context.signal
          ? await terminal.question(prompt, { signal: context.signal })
          : await terminal.question(prompt)).trim();
      } catch (error) {
        if (context.signal?.aborted) throw new MadError("PAUSED", "方案确认已暂停");
        throw error;
      }
      if (!answer) return plan;
      if (answer === "/cancel") throw new MadError("CANCELLED", "已取消审议");
      if (answer.startsWith("/regroup")) {
        const guidance = answer.slice("/regroup".length).trim();
        generation += 1;
        const regrouped = await organizerService.propose({
          question: context.question,
          mode: context.mode,
          limits: context.limits,
          organizer: context.organizer,
          cwd: context.cwd,
          ...(guidance ? { guidance } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          projectMode: context.projectMode,
          proposalId: `planning:organizer:proposal:${generation}`,
        });
        plan = regrouped.plan;
        await context.onCandidate?.(plan, generation);
        continue;
      }
      plan = parseDeliberationPlan(answer, {
        registry: context.registry,
        mode: context.mode,
        limits: context.limits,
        organizer: context.organizer,
      });
      await organizerService.preflightPlan(plan, context.cwd, context.signal, context.projectMode);
      await context.onCandidate?.(plan, generation);
    }
  } finally {
    terminal.close();
  }
}

function coordinatedStructuredCheckpoint(mailbox: CheckpointMailbox, archive: ArchiveStore, terminalAvailable: boolean, signal?: AbortSignal): CheckpointHandler {
  return async (stage, summary) => {
    const key = `structured:${stage}`;
    const state = await archive.readState();
    const remembered = state.checkpointDecisions[key];
    if (remembered) return {
      action: remembered.action as "continue" | "pause" | "cancel",
      ...(remembered.guidance ? { guidance: remembered.guidance } : {}),
    };
    const pending = { kind: stage, summary, actions: ["continue", "guide", "pause", "cancel"] } as const;
    const existingId = state.pendingCheckpoint?.key === key ? state.pendingCheckpoint.checkpointId : undefined;
    const response = await mailbox.wait(
      pending,
      terminalAvailable ? async (signal) => {
        process.stderr.write(`\n检查点 ${stage}：\n${summary}\n`);
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = (await terminal.question("回车继续；/guide 指导；/pause 暂停；/cancel 取消：", { signal })).trim();
          if (answer === "/pause") return { action: "pause" };
          if (answer === "/cancel") return { action: "cancel" };
          if (answer.startsWith("/guide")) return { action: "guide", guidance: answer.slice(6).trim() };
          if (answer) throw new MadError("USAGE", `未知检查点动作：${answer}`);
          return { action: "continue" };
        } finally { terminal.close(); }
      } : undefined,
      signal,
      async (checkpointId) => {
        await archive.setPendingCheckpoint(key, checkpointId, pending);
        await archive.appendEvent("checkpoint.pending", { kind: stage, checkpointId });
      },
      existingId,
      async (accepted) => archive.recordCheckpointDecision(key, {
        action: accepted.action === "guide" ? "continue" : accepted.action,
        ...(accepted.guidance ? { guidance: accepted.guidance } : {}),
        at: accepted.at,
      }),
    );
    const decision = {
      action: response.action === "guide" ? "continue" as const : response.action as "continue" | "pause" | "cancel",
      ...(response.guidance ? { guidance: response.guidance } : {}),
    };
    await archive.recordCheckpointDecision(key, decision);
    await archive.appendEvent("checkpoint.responded", { kind: stage, action: response.action });
    return decision;
  };
}

function coordinatedDiscussionCheckpoint(mailbox: CheckpointMailbox, archive: ArchiveStore, terminalAvailable: boolean, signal?: AbortSignal): DiscussionCheckpoint {
  return async (window, converged, rationale) => {
    const kind = `discussion_window_${window}`;
    const key = `discussion:${window}`;
    const state = await archive.readState();
    const remembered = state.checkpointDecisions[key];
    if (remembered) return {
      action: remembered.action as "continue" | "end" | "pause" | "cancel",
      ...(remembered.guidance ? { guidance: remembered.guidance } : {}),
    };
    const pending = { kind, summary: rationale, actions: ["continue", "guide", "end", "pause", "cancel"] } as const;
    const existingId = state.pendingCheckpoint?.key === key ? state.pendingCheckpoint.checkpointId : undefined;
    const response = await mailbox.wait(
      pending,
      terminalAvailable ? async (signal) => {
        process.stderr.write(`\n讨论窗口 ${window}：${rationale}${converged ? "（主持建议结束）" : ""}\n`);
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = (await terminal.question("回车继续；/guide 指导；/end 结束；/pause 暂停；/cancel 取消：", { signal })).trim();
          if (["/end", "/pause", "/cancel"].includes(answer)) return { action: answer.slice(1) };
          if (answer.startsWith("/guide")) return { action: "guide", guidance: answer.slice(6).trim() };
          if (answer) throw new MadError("USAGE", `未知检查点动作：${answer}`);
          return { action: converged ? "end" : "continue" };
        } finally { terminal.close(); }
      } : undefined,
      signal,
      async (checkpointId) => {
        await archive.setPendingCheckpoint(key, checkpointId, pending);
        await archive.appendEvent("checkpoint.pending", { kind, converged, checkpointId });
      },
      existingId,
      async (accepted) => archive.recordCheckpointDecision(key, {
        action: accepted.action === "guide" ? "continue" : accepted.action,
        ...(accepted.guidance ? { guidance: accepted.guidance } : {}),
        at: accepted.at,
      }),
    );
    const decision = {
      action: response.action === "guide" ? "continue" as const : response.action as "continue" | "end" | "pause" | "cancel",
      ...(response.guidance ? { guidance: response.guidance } : {}),
    };
    await archive.recordCheckpointDecision(key, decision);
    await archive.appendEvent("checkpoint.responded", { kind, action: response.action });
    return decision;
  };
}

async function deliberate(args: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      mode: { type: "string", default: "structured" },
      workspace: { type: "string" },
      auto: { type: "boolean", default: false },
      "auto-confirm-plan": { type: "boolean", default: false },
      format: { type: "string", default: "markdown" },
      organizer: { type: "string" },
      "max-participants": { type: "string" },
      "max-calls": { type: "string" },
      "max-discussion-windows": { type: "string" },
      "timeout-seconds": { type: "string" },
      "context-budget": { type: "string" },
      "global-concurrency": { type: "string" },
    },
  });
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]?.trim()) {
    throw new MadError("USAGE", "deliberate 需要且只接受一个非空问题参数");
  }
  const question = parsed.positionals[0].trim();
  const mode = parsed.values.mode;
  if (mode !== "structured" && mode !== "free") throw new MadError("USAGE", "--mode 必须是 structured 或 free");
  const format = parsed.values.format;
  if (format !== "markdown" && format !== "json") throw new MadError("USAGE", "--format 必须是 markdown 或 json");
  const interaction: InteractionPolicy = parsed.values.auto ? "auto" : "guided";
  if (interaction === "auto" && !parsed.values["auto-confirm-plan"]) {
    throw new MadError("USAGE", "--auto 必须同时显式传入 --auto-confirm-plan");
  }
  const paths = appPaths();
  await Promise.all([
    ensurePrivateDirectory(paths.home),
    ensurePrivateDirectory(paths.deliberations),
    ensurePrivateDirectory(paths.runtime),
  ]);
  const terminalAvailable = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const observerAvailable = await observerIsOnline(paths.runtime);
  if (interaction === "guided" && !terminalAvailable && !observerAvailable) {
    throw new MadError("USAGE", "guided 模式需要交互终端或在线观察服务；当前尚无可用交互通道");
  }
  if (interaction === "guided" && !terminalAvailable && !parsed.values["auto-confirm-plan"]) {
    throw new MadError("USAGE", "无交互终端时必须用 --auto-confirm-plan 接受首次有效组局方案");
  }
  const registry = await loadCliRegistry(paths.config);
  const id = randomUUID();
  let cwd = join(paths.runtime, "scratch", id);
  await ensurePrivateDirectory(cwd);
  let workspace: { path: string; mode: "direct-read-only" } | undefined;
  if (parsed.values.workspace) {
    cwd = await realpath(parsed.values.workspace);
    if (!(await stat(cwd)).isDirectory()) throw new MadError("USAGE", `工作目录不是目录：${cwd}`);
    workspace = { path: cwd, mode: "direct-read-only" };
  }
  const workspaceWarnings = workspace ? [`参与 CLI 已获完整目录只读授权：${workspace.path}`] : [];
  const defaultOrganizer = registry.defaults.generator;
  let organizer = defaultOrganizer;
  if (parsed.values.organizer) {
    const [cli, preset, ...extra] = parsed.values.organizer.split("/");
    if (!cli || !preset || extra.length) throw new MadError("USAGE", "--organizer 格式必须为 CLI/PRESET");
    resolveInvocation(registry, cli, preset);
    organizer = { cli, preset };
  }
  const integerOption = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new MadError("USAGE", `资源上限必须是整数：${value}`);
    return parsed;
  };
  const maxParticipants = integerOption(parsed.values["max-participants"]);
  const maxCalls = integerOption(parsed.values["max-calls"]);
  const maxDiscussionWindows = integerOption(parsed.values["max-discussion-windows"]);
  const timeoutSeconds = integerOption(parsed.values["timeout-seconds"]);
  const contextBudget = integerOption(parsed.values["context-budget"]);
  const globalConcurrency = integerOption(parsed.values["global-concurrency"]);
  const limits = resolveLimits({
    ...(maxParticipants === undefined ? {} : { maxParticipants }),
    ...(maxCalls === undefined ? {} : { maxCalls }),
    ...(maxDiscussionWindows === undefined ? {} : { maxDiscussionWindows }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(contextBudget === undefined ? {} : { contextBudget }),
    ...(globalConcurrency === undefined ? {} : { globalConcurrency }),
  });
  const lock = new ActiveDeliberationLock(`${paths.runtime}/active.lock`);
  await lock.acquire(id);
  const interrupt = new AbortController();
  const onInterrupt = (): void => interrupt.abort();
  process.once("SIGINT", onInterrupt);
  const archive = new ArchiveStore(paths.deliberations, id);
  let archiveCreated = false;
  try {
    const createdAt = new Date().toISOString();
    let planning: NonNullable<DeliberationManifest["planning"]> = {
      organizer,
      limits,
      autoConfirmPlan: parsed.values["auto-confirm-plan"],
      allowRegeneration: interaction === "guided",
      projectMode: Boolean(workspace),
      generation: 0,
    };
    const baseManifest: DeliberationManifest = {
      schemaVersion: 1,
      id,
      createdAt,
      question,
      mode,
      interaction,
      registrySnapshot: snapshotRegistry(registry),
      ...(workspace ? { workspace } : {}),
      planning,
    };
    await archive.create(baseManifest);
    archiveCreated = true;
    process.stderr.write(`审议已创建：${archive.path}\n`);
    await emitWarnings(archive, workspaceWarnings);
    const organizerRunner = new InvocationRunner(
      registry, archive, limits.maxCalls, cwd, createAdapter, undefined, limits.globalConcurrency ?? 6,
    );
    organizerRunner.setSignal(interrupt.signal);
    organizerRunner.setTimeoutSeconds(limits.timeoutSeconds);
    organizerRunner.setContextBudget(limits.contextBudget);
    const organizerService = new OrganizerService(registry, createAdapter, organizerRunner);
    process.stderr.write(`正在组局：${organizer.cli}/${organizer.preset}\n`);
    const proposed = await organizerService.propose({
      question,
      mode,
      limits,
      organizer,
      cwd,
      allowRegeneration: interaction === "guided",
      projectMode: Boolean(workspace),
      signal: interrupt.signal,
      proposalId: "planning:organizer:proposal:0",
    });
    planning = { ...planning, candidatePlan: proposed.plan };
    await archive.writeManifest({ ...baseManifest, planning });
    const plan = interaction === "guided" && !parsed.values["auto-confirm-plan"]
      ? await confirmPlan(proposed.plan, organizerService, {
        registry, question, mode, limits, organizer, cwd, projectMode: Boolean(workspace), signal: interrupt.signal,
        initialGeneration: planning.generation,
        onCandidate: async (candidatePlan, generation) => {
          planning = { ...planning, candidatePlan, generation };
          await archive.writeManifest({ ...baseManifest, planning });
        },
      })
      : proposed.plan;
    if (parsed.values["auto-confirm-plan"]) {
      process.stderr.write(`自动接受首次有效审议方案：\n${JSON.stringify(externalPlan(plan), null, 2)}\n`);
    }
    await archive.writeManifest({
      ...baseManifest,
      plan,
      planning: { ...planning, candidatePlan: plan },
      planConfirmation: parsed.values["auto-confirm-plan"] ? "auto-first-valid" : "interactive",
    });
    await archive.appendEvent("plan.confirmed", { plan: externalPlan(plan), preflighted: proposed.preflightedCombinations });
    const sourceWarning = sharedOriginWarning(plan);
    const sourceWarnings = sourceWarning ? [sourceWarning] : [];
    const warnings = [...workspaceWarnings, ...sourceWarnings];
    await emitWarnings(archive, sourceWarnings);
    const mailbox = new CheckpointMailbox(paths.runtime, id);
    const result = mode === "structured"
      ? await new StructuredController(
        registry,
        archive,
        plan,
        cwd,
        interaction === "guided" ? coordinatedStructuredCheckpoint(mailbox, archive, terminalAvailable, interrupt.signal) : undefined,
        undefined,
        interrupt.signal,
      ).run(question)
      : await new DiscussionController(
        registry,
        archive,
        plan,
        cwd,
        interaction === "guided" ? coordinatedDiscussionCheckpoint(mailbox, archive, terminalAvailable, interrupt.signal) : undefined,
        undefined,
        interrupt.signal,
      ).run(question);
    writeCompletedResult({ format, deliberationId: id, mode, result, plan, warnings, archivePath: archive.path });
    process.stderr.write(`审议档案：${archive.path}\n`);
  } catch (error) {
    if (archiveCreated) {
      const state = await archive.readState();
      if (state.status === "planning") {
        if (error instanceof MadError && error.code === "CANCELLED") await archive.setStatus("cancelled");
        else if (error instanceof MadError && error.code === "PAUSED") await archive.setStatus("paused");
        else await archive.setStatus("failed");
      }
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await lock.release();
  }
}

async function resume(args: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { format: { type: "string", default: "markdown" } },
  });
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]) throw new MadError("USAGE", "resume 需要审议 ID");
  if (parsed.values.format !== "markdown" && parsed.values.format !== "json") {
    throw new MadError("USAGE", "--format 必须是 markdown 或 json");
  }
  const id = parsed.positionals[0];
  const paths = appPaths();
  const archive = new ArchiveStore(paths.deliberations, id);
  const lock = new ActiveDeliberationLock(`${paths.runtime}/active.lock`);
  await lock.acquire(id);
  const interrupt = new AbortController();
  const onInterrupt = (): void => interrupt.abort();
  process.once("SIGINT", onInterrupt);
  try {
    let manifest = await archive.readManifest();
    const registry = registryFromManifest(manifest) ?? await loadCliRegistry(paths.config);
    const state = await archive.readState();
    if (state.status === "completed" || state.status === "cancelled") {
      throw new MadError("USAGE", `审议 ${id} 已处于不可恢复终态：${state.status}`);
    }
    const terminalAvailable = Boolean(process.stdin.isTTY && process.stderr.isTTY);
    const observerAvailable = await observerIsOnline(paths.runtime);
    if (manifest.interaction === "guided" && !terminalAvailable && !observerAvailable) {
      throw new MadError("USAGE", "恢复 guided 审议需要交互终端或在线观察服务");
    }
    const cwd = manifest.workspace?.path ?? join(paths.runtime, "scratch", id);
    if (!manifest.workspace) await ensurePrivateDirectory(cwd);
    if (manifest.workspace) {
      const canonical = await realpath(cwd);
      if (canonical !== cwd || !(await stat(canonical)).isDirectory()) throw new MadError("USAGE", `原工作目录不可用：${cwd}`);
    }
    const workspaceWarnings = manifest.workspace
      ? [`参与 CLI 已获完整目录只读授权：${manifest.workspace.path}`]
      : [];
    await emitWarnings(archive, workspaceWarnings, true);
    let plan = manifest.plan;
    if (!plan) {
      const planning = manifest.planning;
      if (!planning) throw new MadError("EXECUTION", `审议 ${id} 缺少可恢复的组局状态`);
      if (!planning.autoConfirmPlan && !terminalAvailable) {
        throw new MadError("USAGE", "恢复方案确认需要交互终端");
      }
      await archive.setStatus("planning");
      const organizerRunner = new InvocationRunner(
        registry, archive, planning.limits.maxCalls, cwd, createAdapter, undefined, planning.limits.globalConcurrency ?? 6,
      );
      organizerRunner.setSignal(interrupt.signal);
      organizerRunner.setTimeoutSeconds(planning.limits.timeoutSeconds);
      organizerRunner.setContextBudget(planning.limits.contextBudget);
      const organizerService = new OrganizerService(registry, createAdapter, organizerRunner);
      let generation = planning.generation;
      let candidate = planning.candidatePlan;
      if (!candidate) {
        const proposed = await organizerService.propose({
          question: manifest.question,
          mode: manifest.mode,
          limits: planning.limits,
          organizer: planning.organizer,
          cwd,
          allowRegeneration: planning.allowRegeneration,
          projectMode: planning.projectMode,
          signal: interrupt.signal,
          proposalId: `planning:organizer:proposal:${generation}`,
        });
        candidate = proposed.plan;
        manifest = { ...manifest, planning: { ...planning, candidatePlan: candidate, generation } };
        await archive.writeManifest(manifest);
      } else {
        await organizerService.preflightPlan(candidate, cwd, interrupt.signal, planning.projectMode);
      }
      plan = manifest.interaction === "guided" && !planning.autoConfirmPlan
        ? await confirmPlan(candidate, organizerService, {
          registry,
          question: manifest.question,
          mode: manifest.mode,
          limits: planning.limits,
          organizer: planning.organizer,
          cwd,
          projectMode: planning.projectMode,
          signal: interrupt.signal,
          initialGeneration: generation,
          onCandidate: async (candidatePlan, nextGeneration) => {
            generation = nextGeneration;
            manifest = {
              ...manifest,
              planning: { ...planning, candidatePlan, generation: nextGeneration },
            };
            await archive.writeManifest(manifest);
          },
        })
        : candidate;
      manifest = {
        ...manifest,
        plan,
        planning: { ...planning, candidatePlan: plan, generation },
        planConfirmation: planning.autoConfirmPlan ? "auto-first-valid" : "interactive",
      };
      await archive.writeManifest(manifest);
      await archive.appendEvent("plan.confirmed", { plan: externalPlan(plan), resumedPlanning: true });
    } else {
      await new OrganizerService(registry).preflightPlan(plan, cwd, interrupt.signal, Boolean(manifest.workspace));
    }
    const mailbox = new CheckpointMailbox(paths.runtime, id);
    const result = manifest.mode === "structured"
      ? await new StructuredController(
        registry,
        archive,
        plan,
        cwd,
        manifest.interaction === "guided" ? coordinatedStructuredCheckpoint(mailbox, archive, terminalAvailable, interrupt.signal) : undefined,
        undefined,
        interrupt.signal,
      ).run(manifest.question)
      : await new DiscussionController(
        registry,
        archive,
        plan,
        cwd,
        manifest.interaction === "guided" ? coordinatedDiscussionCheckpoint(mailbox, archive, terminalAvailable, interrupt.signal) : undefined,
        undefined,
        interrupt.signal,
      ).run(manifest.question);
    const sourceWarning = sharedOriginWarning(plan);
    const sourceWarnings = sourceWarning ? [sourceWarning] : [];
    const warnings = [...workspaceWarnings, ...sourceWarnings];
    await emitWarnings(archive, sourceWarnings, true);
    writeCompletedResult({
      format: parsed.values.format,
      deliberationId: id,
      mode: manifest.mode,
      result,
      plan,
      warnings,
      archivePath: archive.path,
    });
    process.stderr.write(`审议档案：${archive.path}\n`);
  } catch (error) {
    const current = await archive.readState();
    if (current.status === "planning") {
      if (error instanceof MadError && error.code === "CANCELLED") await archive.setStatus("cancelled");
      else if (error instanceof MadError && error.code === "PAUSED") await archive.setStatus("paused");
      else await archive.setStatus("failed");
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await lock.release();
  }
}

async function serve(args: readonly string[]): Promise<void> {
  const parsed = parseArgs({ args, strict: true, options: { port: { type: "string", default: "0" } } });
  const port = Number.parseInt(parsed.values.port, 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new MadError("USAGE", "--port 必须是 0 到 65535 的整数");
  const observer = await startObserverServer(appPaths(), port);
  process.stderr.write(`审议观察页：${observer.url}\n服务仅监听 127.0.0.1；Bearer Token 只存在于本进程与 URL fragment。\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await observer.close();
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (process.env.MAD_PARTICIPANT === "1" && (command === "deliberate" || command === "resume")) {
    throw new MadError("EXECUTION", "禁止从参与者进程递归调用 mad");
  }
  if (command === "init") {
    const parsed = parseArgs({ args: argv.slice(1), options: { force: { type: "boolean", default: false } }, strict: true });
    await initialize(parsed.values.force);
    return;
  }
  if (command === "config" && (argv[1] === "validate" || argv[1] === "check") && argv.length === 2) {
    await validateConfig(argv[1] === "check");
    return;
  }
  if (command === "deliberate") {
    await deliberate(argv.slice(1));
    return;
  }
  if (command === "resume") {
    await resume(argv.slice(1));
    return;
  }
  if (command === "serve") {
    await serve(argv.slice(1));
    return;
  }
  throw new MadError("USAGE", `未知命令：${argv.join(" ")}\n\n${HELP}`);
}

main().catch((error: unknown) => {
  const madError = error instanceof MadError ? error : new MadError("EXECUTION", error instanceof Error ? error.message : String(error));
  process.stderr.write(`错误：${madError.message}\n`);
  process.exitCode = EXIT_CODES[madError.code];
});
