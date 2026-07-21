import type { ArchiveStore } from "../archive/store.js";
import type { CliRegistry } from "../adapters/config.js";
import { MadError } from "./errors.js";
import { InvocationRunner } from "./execution.js";
import { OutcomePipeline } from "./outcome.js";
import { SharedContextManager } from "./context.js";
import type { DeliberationAgent, DeliberationPlan } from "./types.js";

export interface DiscussionDecision {
  readonly action: "continue" | "end" | "pause" | "cancel";
  readonly guidance?: string;
}
export type DiscussionCheckpoint = (
  window: number,
  converged: boolean,
  rationale: string,
) => Promise<DiscussionDecision>;

interface ModeratorPlan {
  readonly speakers: readonly string[];
  readonly converged: boolean;
  readonly rationale: string;
}

interface Speech {
  readonly round: number;
  readonly agentId: string;
  readonly content: string;
}

export interface DiscussionResult {
  readonly report: string;
  readonly rounds: number;
  readonly windows: number;
  readonly converged: boolean;
  readonly callAttempts: number;
}

function parseObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = /^```json\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const value: unknown = JSON.parse(fenced?.[1] ?? trimmed);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("主持输出必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function parseCoverage(text: string, participantIds: readonly string[]): readonly string[] {
  const value = parseObject(text);
  if (Object.keys(value).some((key) => key !== "order") || !Array.isArray(value.order)) throw new Error("覆盖周期输出只能包含 order 数组");
  const order = value.order;
  if (!order.every((id): id is string => typeof id === "string")) throw new Error("order 只能包含 Agent ID");
  if (order.length !== participantIds.length || new Set(order).size !== order.length || order.some((id) => !participantIds.includes(id))) {
    throw new Error("覆盖周期必须让每位参与者恰好发言一次");
  }
  return order;
}

function parseModeratorPlan(text: string, participantIds: readonly string[], lastSpeaker: string): ModeratorPlan {
  const value = parseObject(text);
  if (Object.keys(value).some((key) => !["speakers", "converged", "rationale"].includes(key))) throw new Error("主持计划包含未知字段");
  if (!Array.isArray(value.speakers) || !value.speakers.every((id): id is string => typeof id === "string")) {
    throw new Error("speakers 必须是 Agent ID 数组");
  }
  if (typeof value.converged !== "boolean" || typeof value.rationale !== "string" || !value.rationale.trim()) {
    throw new Error("converged/rationale 格式无效");
  }
  if (!value.converged && value.speakers.length !== participantIds.length) {
    throw new Error("未收敛时必须规划一个完整检查窗口");
  }
  for (let index = 0; index < value.speakers.length; index += 1) {
    const speaker = value.speakers[index]!;
    if (!participantIds.includes(speaker)) throw new Error(`主持计划引用未知参与者：${speaker}`);
    const previous = index === 0 ? lastSpeaker : value.speakers[index - 1];
    if (speaker === previous) throw new Error("同一参与者不能连续发言");
  }
  return { speakers: value.speakers, converged: value.converged, rationale: value.rationale.trim() };
}

function transcript(speeches: readonly Speech[]): string {
  return speeches.map((speech) => `## 回合 ${speech.round} · ${speech.agentId}\n${speech.content}`).join("\n\n");
}

export class DiscussionController {
  private readonly runner: InvocationRunner;
  private readonly context: SharedContextManager;
  private readonly guidance: string[] = [];

  public constructor(
    registry: CliRegistry,
    private readonly archive: ArchiveStore,
    private readonly plan: DeliberationPlan,
    cwd = process.cwd(),
    private readonly checkpoint?: DiscussionCheckpoint,
    runner?: InvocationRunner,
    signal?: AbortSignal,
  ) {
    if (!plan.moderatorAgentId) throw new MadError("EXECUTION", "自由讨论方案缺少主持 Agent");
    this.runner = runner ?? new InvocationRunner(registry, archive, plan.limits.maxCalls, cwd);
    this.runner.setSignal(signal);
    this.runner.setTimeoutSeconds(plan.limits.timeoutSeconds);
    this.context = new SharedContextManager(registry, this.runner, plan);
  }

  public async run(question: string): Promise<DiscussionResult> {
    this.context.reset();
    if (this.guidance.length === 0) this.guidance.push(...(await this.archive.readState()).guidance);
    await this.archive.setStatus("running");
    const speeches: Speech[] = [];
    let windows = 0;
    let converged = false;
    try {
      const moderator = this.agent(this.plan.moderatorAgentId!);
      const participantIds = this.plan.participants.map((agent) => agent.id);
      const coverage = await this.runner.run({
        id: "discussion:moderator:coverage",
        kind: "moderator",
        agentId: moderator.id,
        invocation: moderator.invocation,
        stage: "moderator_coverage",
        prompt: `你是主持 Agent ${moderator.id}。问题：${question}\n参与者与角色：${JSON.stringify(this.plan.participants)}\n` +
          `规划覆盖周期，使每位参与者恰好发言一次。主持调度不是你的参与者观点。只输出 JSON：{"order":["agent-id"]}`,
        parse: (text) => parseCoverage(text, participantIds),
      });
      for (const agentId of coverage.value) await this.speak(question, this.agent(agentId), "coverage", speeches);

      let moderatorPlan = await this.evaluate(question, moderator, participantIds, speeches, 0);
      while (windows < this.plan.limits.maxDiscussionWindows) {
        const decision = await this.atBoundary(windows, moderatorPlan);
        if (decision === "end" || moderatorPlan.converged) {
          converged = moderatorPlan.converged;
          break;
        }
        windows += 1;
        for (const agentId of moderatorPlan.speakers) {
          await this.speak(question, this.agent(agentId), `window_${windows}`, speeches);
        }
        moderatorPlan = await this.evaluate(question, moderator, participantIds, speeches, windows);
      }
      if (moderatorPlan.converged) converged = true;
      const evidence = `自由讨论权威发言记录（主持调度不作为参与者观点）：\n${await this.context.snapshot(question)}\n\n` +
        `讨论状态：${converged ? "主持判断已收敛" : "达到用户结束或窗口上限，可能仍有未决争议"}`;
      const report = await new OutcomePipeline(this.runner, this.plan).run(question, evidence, this.guidanceText());
      await this.archive.writeReport(report);
      await this.archive.setStatus("completed");
      const state = await this.archive.readState();
      return { report, rounds: speeches.length, windows, converged, callAttempts: state.callAttempts };
    } catch (error) {
      if (error instanceof MadError && error.code === "CANCELLED") await this.archive.setStatus("cancelled");
      else await this.archive.setStatus("paused");
      throw error;
    }
  }

  private async speak(question: string, agent: DeliberationAgent, phase: string, speeches: Speech[]): Promise<void> {
    const round = speeches.length + 1;
    const sharedContext = await this.context.snapshot(question);
    const output = await this.runner.run({
      id: `discussion:speech:${phase}:${round}:${agent.id}`,
      kind: "contribution",
      agentId: agent.id,
      invocation: agent.invocation,
      stage: "discussion_speech",
      prompt: `你是 ${agent.id}，本次角色：${agent.role}\n问题：${question}\n此前共享权威上下文：\n${sharedContext}\n` +
        `这是你的第 ${round} 个讨论回合。回应相关观点，推进结论，明确分歧；不要代替主持人调度。${this.guidanceText()}`,
    });
    speeches.push({ round, agentId: agent.id, content: output.value });
    this.context.add(`回合 ${round} · ${agent.id}`, output.value);
  }

  private async evaluate(
    question: string,
    moderator: DeliberationAgent,
    participantIds: readonly string[],
    speeches: readonly Speech[],
    window: number,
  ): Promise<ModeratorPlan> {
    const lastSpeaker = speeches.at(-1)?.agentId ?? "";
    const sharedContext = await this.context.snapshot(question);
    const result = await this.runner.run({
      id: `discussion:moderator:window:${window}`,
      kind: "moderator",
      agentId: moderator.id,
      invocation: moderator.invocation,
      stage: "moderator_window",
      prompt: `你是主持 Agent ${moderator.id}。问题：${question}\n共享权威参与者上下文：\n${sharedContext}\n` +
        `评估是否已充分收敛；若未收敛，为下一个窗口规划恰好 ${participantIds.length} 个发言者。允许重复但不得连续选择同一人，第一位不能是上一位 ${lastSpeaker}。` +
        `主持判断只用于调度，不是参与者观点。只输出 JSON：{"speakers":["agent-id"],"converged":false,"rationale":"理由"}${this.guidanceText()}`,
      parse: (text) => parseModeratorPlan(text, participantIds, lastSpeaker),
    });
    return result.value;
  }

  private async atBoundary(window: number, plan: ModeratorPlan): Promise<"continue" | "end"> {
    if (!this.checkpoint) return plan.converged ? "end" : "continue";
    await this.archive.setStatus("waiting_checkpoint");
    const decision = await this.checkpoint(window, plan.converged, plan.rationale);
    if (decision.guidance?.trim()) {
      this.guidance.push(decision.guidance.trim());
      await this.archive.addGuidance(decision.guidance);
    }
    if (decision.action === "pause") throw new MadError("PAUSED", "审议已暂停");
    if (decision.action === "cancel") throw new MadError("CANCELLED", "审议已取消");
    await this.archive.setStatus("running");
    return decision.action === "end" ? "end" : "continue";
  }

  private guidanceText(): string {
    return this.guidance.length ? `\n用户指导：\n${this.guidance.join("\n")}` : "";
  }

  private agent(id: string): DeliberationAgent {
    const agent = this.plan.participants.find((participant) => participant.id === id);
    if (!agent) throw new MadError("EXECUTION", `方案引用未知 Agent：${id}`);
    return agent;
  }
}
