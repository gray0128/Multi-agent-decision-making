import type { DeliberationAgent, DeliberationPlan } from "./types.js";
import { settleAllOrThrow, type InvocationRunner } from "./execution.js";
import type { SharedContextManager } from "./context.js";
import { estimateTokens } from "./tokens.js";

export function sharedOriginWarning(plan: DeliberationPlan): string {
  const counts = new Map<string, number>();
  for (const participant of plan.participants) {
    const key = `${participant.invocation.cli}/${participant.invocation.preset}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared = [...counts].filter(([, count]) => count > 1).map(([key, count]) => `${key} 被 ${count} 个角色共享`);
  return shared.length ? `来源约束：${shared.join("；")}。不得把这些角色的一致意见描述为独立模型交叉验证。` : "";
}

function render(outputs: ReadonlyMap<string, string>): string {
  return [...outputs].map(([agent, content]) => `## ${agent}\n${content}`).join("\n\n");
}

function validateFinalReport(text: string): string {
  const value = text.trim();
  const requirements: Array<[RegExp, string]> = [
    [/^#{1,3}\s+/m, "Markdown 标题"],
    [/(共识|consensus)/i, "共识"],
    [/(未决争议|分歧|dispute)/i, "未决争议"],
    [/(假设|assumption)/i, "假设"],
    [/(风险|risk)/i, "风险"],
  ];
  const missing = requirements.filter(([pattern]) => !pattern.test(value)).map(([, label]) => label);
  if (missing.length) throw new Error(`最终报告缺少必需部分：${missing.join("、")}`);
  return value;
}

export class OutcomePipeline {
  public constructor(
    private readonly runner: InvocationRunner,
    private readonly plan: DeliberationPlan,
    private readonly context?: SharedContextManager,
  ) {}

  public async run(
    question: string,
    supplementalEvidence: string,
    guidance: string | (() => string) = "",
    onDraft?: (draft: string) => Promise<void>,
  ): Promise<string> {
    const reportAgent = this.agent(this.plan.reportAgentId);
    const currentGuidance = (): string => typeof guidance === "function" ? guidance() : guidance;
    if (this.context && supplementalEvidence.trim()) this.context.add("补充证据", supplementalEvidence.trim());
    const draftPrompt = (evidence: string): string =>
      `你是报告 Agent ${reportAgent.id}。问题：${question}\n${sharedOriginWarning(this.plan)}\n${evidence}` +
      `${this.context ? "" : supplementalEvidence}\n` +
      `生成 Markdown 草稿，明确区分共识、未决争议、假设和风险，不得虚构一致意见。${currentGuidance()}`;
    const evidence = this.context
      ? await this.context.snapshot(question, estimateTokens(draftPrompt("")) + 1)
      : "";
    const draft = await this.runner.run({
      id: "outcome:report:draft",
      kind: "draft",
      agentId: reportAgent.id,
      invocation: reportAgent.invocation,
      stage: "report_draft",
      prompt: draftPrompt(evidence),
    });
    await onDraft?.(draft.value);
    this.context?.add("报告草稿", draft.value);
    const reviewers = this.plan.participants.filter((agent) => agent.id !== reportAgent.id);
    const reviewPrompt = (agent: DeliberationAgent, reviewContext: string): string =>
      `你是审阅者 ${agent.id}，角色：${agent.role}\n问题：${question}\n权威证据与报告草稿：\n${reviewContext}\n` +
      `检查是否忠实反映各方观点、来源共享、未决争议、假设与风险；给出具体修订建议。${currentGuidance()}`;
    const reviewReserve = reviewers.length
      ? Math.max(...reviewers.map((agent) => estimateTokens(reviewPrompt(agent, "")))) + 1
      : 0;
    const reviewContext = this.context
      ? await this.context.snapshot(question, reviewReserve)
      : `${supplementalEvidence}\n\n## 报告草稿\n${draft.value}`;
    const reviewValues = await settleAllOrThrow(reviewers.map(async (agent) => {
      const review = await this.runner.run({
        id: `outcome:review:${agent.id}`,
        kind: "review",
        agentId: agent.id,
        invocation: agent.invocation,
        stage: "review",
        prompt: reviewPrompt(agent, reviewContext),
      });
      return [agent.id, review.value] as const;
    }));
    this.context?.addMany(reviewValues.map(([agentId, value]) => [`报告审阅 · ${agentId}`, value] as const));
    const finalPrompt = (finalContext: string): string =>
      `你是报告 Agent ${reportAgent.id}。问题：${question}\n权威证据、草稿与审阅意见：\n${finalContext}\n` +
      `${sharedOriginWarning(this.plan)}\n${currentGuidance()}\n完成一次最终修订，只输出最终 Markdown 报告。`;
    const finalContext = this.context
      ? await this.context.snapshot(question, estimateTokens(finalPrompt("")) + 1)
      : `${reviewContext}\n\n## 审阅意见\n${render(new Map(reviewValues))}`;
    const final = await this.runner.run({
      id: "outcome:report:final",
      kind: "final",
      agentId: reportAgent.id,
      invocation: reportAgent.invocation,
      stage: "report_final",
      prompt: finalPrompt(finalContext),
      parse: validateFinalReport,
    });
    return final.value;
  }

  private agent(id: string): DeliberationAgent {
    const agent = this.plan.participants.find((participant) => participant.id === id);
    if (!agent) throw new Error(`方案引用未知 Agent：${id}`);
    return agent;
  }
}
