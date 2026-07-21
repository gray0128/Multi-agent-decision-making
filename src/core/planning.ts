import type { AdapterFactory, CliAdapter } from "../adapters/types.js";
import { createAdapter } from "../adapters/index.js";
import type { CliRegistry } from "../adapters/config.js";
import { resolveInvocation } from "../adapters/config.js";
import { MadError } from "./errors.js";
import type {
  DeliberationAgent,
  DeliberationMode,
  DeliberationPlan,
  InvocationPresetRef,
  ResourceLimits,
} from "./types.js";
import { InvocationScheduler, settleAllOrThrow, type InvocationRunner } from "./execution.js";

type JsonObject = Record<string, unknown>;
const AGENT_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MadError("EXECUTION", `${path} 必须是 JSON 对象`);
  }
  return value as JsonObject;
}

function keysOnly(value: JsonObject, keys: readonly string[], path: string): void {
  const extras = Object.keys(value).filter((key) => !keys.includes(key));
  if (extras.length) throw new MadError("EXECUTION", `${path} 包含禁止字段：${extras.join(", ")}`);
}

function requiredString(value: unknown, path: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new MadError("EXECUTION", `${path} 必须是非空字符串`);
  const result = value.trim();
  if (result.length > max) throw new MadError("EXECUTION", `${path} 最长为 ${max} 个字符`);
  return result;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```json\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const source = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new MadError("EXECUTION", `组局结果不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ParsePlanOptions {
  readonly registry: CliRegistry;
  readonly mode: DeliberationMode;
  readonly limits: ResourceLimits;
  readonly organizer: InvocationPresetRef;
}

export function parseDeliberationPlan(payload: string | unknown, options: ParsePlanOptions): DeliberationPlan {
  const raw = asObject(typeof payload === "string" ? extractJson(payload) : payload, "plan");
  const allowedKeys = options.mode === "free"
    ? ["participants", "report_agent_id", "moderator_agent_id"]
    : ["participants", "report_agent_id"];
  keysOnly(raw, allowedKeys, "plan");
  if (!Array.isArray(raw.participants)) throw new MadError("EXECUTION", "plan.participants 必须是数组");
  if (raw.participants.length < 2) throw new MadError("EXECUTION", "审议方案至少需要两个参与者");
  if (raw.participants.length > options.limits.maxParticipants) {
    throw new MadError("EXECUTION", `参与者数量超过上限 ${options.limits.maxParticipants}`);
  }
  const participants: DeliberationAgent[] = raw.participants.map((item, index) => {
    const path = `plan.participants[${index}]`;
    const participant = asObject(item, path);
    keysOnly(participant, ["id", "cli", "preset", "role"], path);
    const id = requiredString(participant.id, `${path}.id`, 64);
    if (!AGENT_ID.test(id)) throw new MadError("EXECUTION", `${path}.id 不是有效 ID`);
    const cli = requiredString(participant.cli, `${path}.cli`, 64);
    const preset = requiredString(participant.preset, `${path}.preset`, 64);
    resolveInvocation(options.registry, cli, preset);
    return {
      id,
      invocation: { cli, preset },
      role: requiredString(participant.role, `${path}.role`),
    };
  });
  const ids = participants.map((participant) => participant.id);
  if (new Set(ids).size !== ids.length) throw new MadError("EXECUTION", "审议方案包含重复参与者 ID");
  const reportAgentId = requiredString(raw.report_agent_id, "plan.report_agent_id", 64);
  if (!ids.includes(reportAgentId)) throw new MadError("EXECUTION", "报告 Agent 必须是参与者");
  const resolved = participants.map((participant) =>
    resolveInvocation(options.registry, participant.invocation.cli, participant.invocation.preset));
  const effectiveLimits: ResourceLimits = {
    ...options.limits,
    timeoutSeconds: Math.min(options.limits.timeoutSeconds, ...resolved.map(({ cli }) => cli.timeoutSeconds)),
    contextBudget: Math.min(options.limits.contextBudget, ...resolved.map(({ preset }) => preset.contextBudget)),
  };
  if (options.mode === "free") {
    const moderatorAgentId = requiredString(raw.moderator_agent_id, "plan.moderator_agent_id", 64);
    if (!ids.includes(moderatorAgentId)) throw new MadError("EXECUTION", "主持 Agent 必须是参与者");
    return {
      organizer: options.organizer,
      participants,
      reportAgentId,
      moderatorAgentId,
      limits: effectiveLimits,
    };
  }
  return { organizer: options.organizer, participants, reportAgentId, limits: effectiveLimits };
}

export interface OrganizerRequest {
  readonly question: string;
  readonly mode: DeliberationMode;
  readonly limits: ResourceLimits;
  readonly cwd: string;
  readonly organizer?: InvocationPresetRef;
  readonly guidance?: string;
  readonly signal?: AbortSignal;
  readonly allowRegeneration?: boolean;
  readonly projectMode?: boolean;
  readonly proposalId?: string;
}

export interface OrganizerResult {
  readonly plan: DeliberationPlan;
  readonly preflightedCombinations: readonly string[];
}

export class OrganizerService {
  public constructor(
    private readonly registry: CliRegistry,
    private readonly adapterFactory: AdapterFactory = createAdapter,
    private readonly runner?: InvocationRunner,
  ) {}

  public async propose(request: OrganizerRequest): Promise<OrganizerResult> {
    const organizer = request.organizer ?? this.registry.defaults.generator;
    const generator = resolveInvocation(this.registry, organizer.cli, organizer.preset);
    const generatorAdapter = this.adapterFactory(generator.cli, generator.preset);
    if (request.projectMode) await this.requireProjectReadOnly(generatorAdapter, `${organizer.cli}/${organizer.preset}`, request.signal);
    await this.requireReady(generatorAdapter, request.cwd, `${organizer.cli}/${organizer.preset}`, request.signal);
    const prompt = this.buildPrompt(request, organizer);
    let plan: DeliberationPlan | undefined;
    if (this.runner) {
      const result = await this.runner.run({
        id: request.proposalId ?? "planning:organizer:proposal:0",
        kind: "organizer",
        agentId: "organizer",
        invocation: organizer,
        prompt,
        stage: "planning",
        ...(request.signal ? { signal: request.signal } : {}),
        parse: (text) => parseDeliberationPlan(text, {
          registry: this.registry,
          mode: request.mode,
          limits: request.limits,
          organizer,
        }),
      });
      plan = result.value;
    } else {
      let validationError = "";
      const maximumAttempts = request.allowRegeneration === false ? 1 : 2;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        const result = await generatorAdapter.invoke({
          prompt: attempt === 0 ? prompt : `${prompt}\n\n上次输出校验失败：${validationError}\n重新生成完整 JSON。`,
          cwd: request.cwd,
          timeoutMs: Math.min(request.limits.timeoutSeconds, generator.cli.timeoutSeconds) * 1_000,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        try {
          plan = parseDeliberationPlan(result.text, {
            registry: this.registry,
            mode: request.mode,
            limits: request.limits,
            organizer,
          });
          break;
        } catch (error) {
          validationError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!plan) throw new MadError("EXECUTION", `组局方案校验失败：${validationError}`);
    }
    const preflightedCombinations = await this.preflightPlan(plan, request.cwd, request.signal, request.projectMode ?? false);
    return { plan, preflightedCombinations };
  }

  public async preflightPlan(plan: DeliberationPlan, cwd: string, signal?: AbortSignal, projectMode = false): Promise<string[]> {
    const combinations = new Map<string, { adapter: CliAdapter; cliId: string; maximum: number }>();
    for (const participant of plan.participants) {
      const key = `${participant.invocation.cli}/${participant.invocation.preset}`;
      if (!combinations.has(key)) {
        const resolved = resolveInvocation(this.registry, participant.invocation.cli, participant.invocation.preset);
        const adapter = this.adapterFactory(resolved.cli, resolved.preset);
        combinations.set(key, { adapter, cliId: resolved.cli.id, maximum: resolved.cli.maxConcurrency });
      }
    }
    const scheduler = new InvocationScheduler(plan.limits.globalConcurrency ?? 6);
    await settleAllOrThrow([...combinations].map(([key, value]) =>
      scheduler.run(value.cliId, value.maximum, async () => {
        if (projectMode) await this.requireProjectReadOnly(value.adapter, key, signal);
        await this.requireReady(value.adapter, cwd, key, signal);
      })));
    return [...combinations.keys()];
  }

  private async requireReady(adapter: CliAdapter, cwd: string, label: string, signal?: AbortSignal): Promise<void> {
    const result = await adapter.check(cwd, signal);
    if (signal?.aborted) throw new MadError("PAUSED", "审议已暂停");
    if (!result.ready) throw new MadError("PREFLIGHT", `${label} 预检失败：${result.detail ?? "未知错误"}`);
  }

  private async requireProjectReadOnly(adapter: CliAdapter, label: string, signal?: AbortSignal): Promise<void> {
    if (adapter.projectReadOnlyCapability === "unsupported") {
      throw new MadError("PREFLIGHT", `${label} 未证明支持最低只读约束，禁止项目模式`);
    }
    const result = await adapter.verifyProjectReadOnly(signal);
    if (signal?.aborted) throw new MadError("PAUSED", "审议已暂停");
    if (!result.verified) {
      throw new MadError("PREFLIGHT", `${label} 项目只读验证失败：${result.detail ?? "证据不足"}`);
    }
  }

  private buildPrompt(request: OrganizerRequest, organizer: InvocationPresetRef): string {
    const registryView = this.registry.clis.map((cli) => ({
      cli: cli.id,
      adapter: cli.adapter,
      presets: cli.presets.map((preset) => ({ id: preset.id, context_budget: preset.contextBudget })),
    }));
    const moderator = request.mode === "free" ? ',"moderator_agent_id":"agent-id"' : "";
    return `你是一次性组局 Agent。围绕当前问题生成本次审议的临时 Agent 与角色。\n` +
      `只能引用安全注册表中的 cli 与 preset ID，不得输出模型名、命令、可执行路径、CLI 参数、权限、环境变量、秘密或配置修改。\n` +
      `参与者为 2 到 ${request.limits.maxParticipants} 名；同一 cli/preset 可以创建多个不同角色实例，但它们共享模型来源。\n` +
      `${request.mode === "free" ? "参与者不少于三名时，优先让主持 Agent 与报告 Agent 使用不同实例，但这不是硬性约束。\n" : ""}` +
      `模式：${request.mode}\n问题：\n${request.question}\n` +
      `资源限制：${JSON.stringify(request.limits)}\n组局器：${organizer.cli}/${organizer.preset}\n` +
      `${request.guidance ? `用户组局指导：\n${request.guidance}\n` : ""}` +
      `安全注册表：\n${JSON.stringify(registryView, null, 2)}\n` +
      `只输出 JSON：{"participants":[{"id":"agent-id","cli":"注册表 ID","preset":"预设 ID","role":"本次角色"}],"report_agent_id":"agent-id"${moderator}}`;
  }
}
