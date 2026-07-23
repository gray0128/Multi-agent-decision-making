import type { ArchiveStore } from "../archive/store.js";
import type { CliRegistry } from "../adapters/config.js";
import { MadError } from "./errors.js";
import { InvocationRunner, settleAllOrThrow } from "./execution.js";
import { OutcomePipeline } from "./outcome.js";
import { estimateTokens, SharedContextManager } from "./context.js";
import type { DeliberationAgent, DeliberationPlan } from "./types.js";
import { createAdapter } from "../adapters/index.js";

export type StructuredCheckpointStage = "independent" | "challenge" | "disputes" | "draft";
export interface CheckpointDecision {
  readonly action: "continue" | "pause" | "cancel";
  readonly guidance?: string;
}
export type CheckpointHandler = (
  stage: StructuredCheckpointStage,
  summary: string,
) => Promise<CheckpointDecision>;

interface Revision {
  readonly position: string;
  readonly disputes: readonly { readonly topic: string; readonly stance: string; readonly confidence: "low" | "medium" | "high" }[];
}

const REVISION_SCHEMA = {
  type: "object",
  properties: {
    position: { type: "string" },
    disputes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          stance: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["topic", "stance", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["position", "disputes"],
  additionalProperties: false,
} as const;

export interface StructuredResult {
  readonly report: string;
  readonly disputes: readonly string[];
  readonly callAttempts: number;
}

function jsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const match = /^```json\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const value: unknown = JSON.parse(match?.[1] ?? trimmed);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function parseRevision(text: string): Revision {
  const value = jsonObject(text);
  const extras = Object.keys(value).filter((key) => !["position", "disputes"].includes(key));
  if (extras.length) throw new Error(`修订输出包含未知字段：${extras.join(", ")}`);
  if (typeof value.position !== "string" || !value.position.trim()) throw new Error("position 必须是非空字符串");
  if (!Array.isArray(value.disputes)) throw new Error("disputes 必须是数组");
  const disputes = value.disputes.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`disputes[${index}] 格式无效`);
    const raw = item as Record<string, unknown>;
    const keys = Object.keys(raw).filter((key) => !["topic", "stance", "confidence"].includes(key));
    if (keys.length) throw new Error(`disputes[${index}] 包含未知字段`);
    if (typeof raw.topic !== "string" || !raw.topic.trim() || typeof raw.stance !== "string" || !raw.stance.trim()) {
      throw new Error(`disputes[${index}] 的 topic/stance 无效`);
    }
    if (!["low", "medium", "high"].includes(raw.confidence as string)) throw new Error(`disputes[${index}] 的 confidence 无效`);
    return { topic: raw.topic.trim(), stance: raw.stance.trim(), confidence: raw.confidence as "low" | "medium" | "high" };
  });
  return { position: value.position.trim(), disputes };
}

function renderOutputs(outputs: ReadonlyMap<string, string>): string {
  return [...outputs].map(([agent, content]) => `## ${agent}\n${content}`).join("\n\n");
}

export class StructuredController {
  private readonly runner: InvocationRunner;
  private readonly context: SharedContextManager;
  private readonly guidance: string[] = [];

  public constructor(
    registry: CliRegistry,
    private readonly archive: ArchiveStore,
    private readonly plan: DeliberationPlan,
    cwd = process.cwd(),
    private readonly checkpoint?: CheckpointHandler,
    runner?: InvocationRunner,
    signal?: AbortSignal,
  ) {
    this.runner = runner ?? new InvocationRunner(
      registry, archive, plan.limits.maxCalls, cwd, createAdapter, undefined, plan.limits.globalConcurrency ?? 6,
    );
    this.runner.setSignal(signal);
    this.runner.setTimeoutSeconds(plan.limits.timeoutSeconds);
    this.runner.setContextBudget(plan.limits.contextBudget);
    this.context = new SharedContextManager(registry, this.runner, plan);
  }

  public async run(question: string): Promise<StructuredResult> {
    this.context.reset();
    if (this.guidance.length === 0) this.guidance.push(...(await this.archive.readState()).guidance);
    await this.archive.setStatus("running");
    try {
      const independent = await this.parallel("independent", this.plan.participants, (agent) =>
        `你是 ${agent.id}，本次角色：${agent.role}\n问题：${question}\n独立提出判断、证据、假设和风险。不要假设已看到其他参与者输出。`,
      );
      this.context.addMany(this.plan.participants.map((agent) => [`独立陈述 · ${agent.id}`, independent.get(agent.id)!] as const));
      await this.pauseAt("independent", renderOutputs(independent));

      const challengePrompt = (agent: DeliberationAgent, sharedContext: string): string =>
        `你是 ${agent.id}，角色：${agent.role}\n问题：${question}\n共享权威上下文：\n${sharedContext}\n` +
        `质疑薄弱证据、指出遗漏并补充材料。${this.guidanceText()}`;
      const challengeReserve = Math.max(...this.plan.participants.map((agent) => estimateTokens(challengePrompt(agent, "")))) + 1;
      const independentContext = await this.context.snapshot(question, challengeReserve);
      const challenge = await this.parallel("challenge", this.plan.participants, (agent) =>
        challengePrompt(agent, independentContext),
      );
      this.context.addMany(this.plan.participants.map((agent) => [`质疑补充 · ${agent.id}`, challenge.get(agent.id)!] as const));
      await this.pauseAt("challenge", renderOutputs(challenge));

      const revisionPrompt = (agent: DeliberationAgent, sharedContext: string): string =>
        `你是 ${agent.id}，角色：${agent.role}\n问题：${question}\n共享权威上下文：\n${sharedContext}\n` +
        `修订你的立场并标记关键争议。只输出 JSON：` +
        `{"position":"修订意见","disputes":[{"topic":"争议主题","stance":"你的明确立场","confidence":"low|medium|high"}]}${this.guidanceText()}`;
      const revisionReserve = Math.max(...this.plan.participants.map((agent) => estimateTokens(revisionPrompt(agent, "")))) + 1;
      const challengeContext = await this.context.snapshot(question, revisionReserve);
      const revisions = new Map<string, Revision>();
      await settleAllOrThrow(this.plan.participants.map(async (agent) => {
        const output = await this.runner.run({
          id: `structured:revision:${agent.id}`,
          kind: "contribution",
          agentId: agent.id,
          invocation: agent.invocation,
          stage: "revision",
          prompt: revisionPrompt(agent, challengeContext),
          jsonSchema: REVISION_SCHEMA,
          parse: parseRevision,
        });
        revisions.set(agent.id, output.value);
      }));
      this.context.addMany(this.plan.participants.map((agent) => {
        const revision = revisions.get(agent.id)!;
        return [`修订意见 · ${agent.id}`, `${revision.position}\n争议信号：${JSON.stringify(revision.disputes)}`] as const;
      }));
      const disputeTopics = this.findDisputes(revisions);
      await this.pauseAt("disputes", disputeTopics.length ? disputeTopics.join("\n") : "未检测到关键立场冲突");

      const convergencePrompt = (agent: DeliberationAgent, sharedContext: string): string =>
        `你是 ${agent.id}。围绕以下已识别争议进行唯一一次收敛回应：\n${disputeTopics.join("\n")}\n` +
        `共享权威上下文：\n${sharedContext}\n` +
        `明确可接受共识、仍不同意之处及所需证据。${this.guidanceText()}`;
      const convergenceReserve = Math.max(...this.plan.participants.map((agent) => estimateTokens(convergencePrompt(agent, "")))) + 1;
      const revisionContext = await this.context.snapshot(question, convergenceReserve);
      const convergence = disputeTopics.length
        ? await this.parallel("convergence", this.plan.participants, (agent) =>
          convergencePrompt(agent, revisionContext),
        )
        : new Map<string, string>();
      this.context.addMany(this.plan.participants.filter((agent) => convergence.has(agent.id)).map((agent) =>
        [`争议收敛 · ${agent.id}`, convergence.get(agent.id)!] as const));

      const report = await new OutcomePipeline(this.runner, this.plan, this.context).run(
        question,
        "",
        () => this.guidanceText(),
        (draft) => this.pauseAt("draft", draft),
      );
      await this.archive.writeReport(report);
      await this.archive.setStatus("completed");
      const state = await this.archive.readState();
      return { report, disputes: disputeTopics, callAttempts: state.callAttempts };
    } catch (error) {
      if (error instanceof MadError && error.code === "CANCELLED") await this.archive.setStatus("cancelled");
      else await this.archive.setStatus("paused");
      throw error;
    }
  }

  private async parallel(
    stage: string,
    agents: readonly DeliberationAgent[],
    prompt: (agent: DeliberationAgent) => string,
    kind: "contribution" | "review" = "contribution",
  ): Promise<Map<string, string>> {
    const values = await settleAllOrThrow(agents.map(async (agent) => {
      const output = await this.runner.run({
        id: `structured:${stage}:${agent.id}`,
        kind,
        agentId: agent.id,
        invocation: agent.invocation,
        stage,
        prompt: prompt(agent),
      });
      return [agent.id, output.value] as const;
    }));
    return new Map(values);
  }

  private findDisputes(revisions: ReadonlyMap<string, Revision>): string[] {
    const topics = new Map<string, { label: string; stances: Set<string> }>();
    for (const revision of revisions.values()) {
      for (const dispute of revision.disputes) {
        const key = dispute.topic.toLocaleLowerCase();
        const entry = topics.get(key) ?? { label: dispute.topic, stances: new Set<string>() };
        entry.stances.add(dispute.stance.toLocaleLowerCase());
        topics.set(key, entry);
      }
    }
    return [...topics.values()].filter((entry) => entry.stances.size > 1).map((entry) => entry.label);
  }

  private async pauseAt(stage: StructuredCheckpointStage, summary: string): Promise<void> {
    if (!this.checkpoint) return;
    const key = `structured:${stage}`;
    const remembered = (await this.archive.readState()).checkpointDecisions[key];
    let decision: CheckpointDecision;
    if (remembered) {
      decision = {
        action: remembered.action as CheckpointDecision["action"],
        ...(remembered.guidance ? { guidance: remembered.guidance } : {}),
      };
    } else {
      await this.archive.setStatus("waiting_checkpoint");
      decision = await this.checkpoint(stage, summary);
      await this.archive.recordCheckpointDecision(key, decision);
    }
    if (decision.guidance?.trim()) {
      const guidance = decision.guidance.trim();
      if (!this.guidance.includes(guidance)) {
        this.guidance.push(guidance);
        await this.archive.addGuidance(guidance);
      }
    }
    if (decision.action === "pause") throw new MadError("PAUSED", "审议已暂停");
    if (decision.action === "cancel") throw new MadError("CANCELLED", "审议已取消");
    await this.archive.setStatus("running");
  }

  private guidanceText(): string {
    return this.guidance.length ? `\n用户指导：\n${this.guidance.join("\n")}` : "";
  }

}
