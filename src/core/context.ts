import type { CliRegistry } from "../adapters/config.js";
import { resolveInvocation } from "../adapters/config.js";
import { MadError } from "./errors.js";
import type { InvocationRunner } from "./execution.js";
import type { DeliberationPlan } from "./types.js";

interface ContextEntry {
  readonly label: string;
  readonly content: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class SharedContextManager {
  private readonly entries: ContextEntry[] = [];
  private summary = "";
  private summarizedEntries = 0;
  private readonly contextBudget: number;

  public constructor(
    registry: CliRegistry,
    private readonly runner: InvocationRunner,
    private readonly plan: DeliberationPlan,
  ) {
    this.contextBudget = Math.min(
      plan.limits.contextBudget,
      ...plan.participants.map((participant) =>
        resolveInvocation(registry, participant.invocation.cli, participant.invocation.preset).preset.contextBudget),
    );
  }

  public add(label: string, content: string): void {
    this.entries.push({ label, content });
  }

  public reset(): void {
    this.entries.length = 0;
    this.summary = "";
    this.summarizedEntries = 0;
  }

  public addMany(values: readonly (readonly [string, string])[]): void {
    for (const [label, content] of values) this.add(label, content);
  }

  public async snapshot(question: string): Promise<string> {
    const current = this.renderCurrent();
    if (estimateTokens(current) <= Math.floor(this.contextBudget * 0.6)) return current;
    const reportAgent = this.plan.participants.find((participant) => participant.id === this.plan.reportAgentId);
    if (!reportAgent) throw new MadError("EXECUTION", "报告 Agent 不存在，无法生成统一滚动摘要");
    const through = this.entries.length;
    const maximumCharacters = Math.max(32, Math.floor(this.contextBudget * 4 * 0.3));
    const result = await this.runner.run({
      id: `context:summary:${this.summarizedEntries}:${through}`,
      kind: "summary",
      agentId: reportAgent.id,
      invocation: reportAgent.invocation,
      stage: "context_summary",
      prompt: `你是报告 Agent ${reportAgent.id}。为所有参与者生成同一份权威滚动摘要。\n问题：${question}\n` +
        `保留各参与者身份、关键证据、立场、争议、假设、风险及尚待执行的任务约束；不得把共享调用来源说成独立模型验证。` +
        `不要加入新判断，不超过 ${maximumCharacters} 个字符。\n待摘要记录：\n${current}`,
      parse: (text) => {
        const value = text.trim();
        if (!value) throw new Error("滚动摘要为空");
        if (value.length > maximumCharacters) throw new Error(`滚动摘要超过 ${maximumCharacters} 字符`);
        return value;
      },
    });
    this.summary = result.value;
    this.summarizedEntries = through;
    return this.renderCurrent();
  }

  private renderCurrent(): string {
    const recent = this.entries.slice(this.summarizedEntries)
      .map((entry) => `## ${entry.label}\n${entry.content}`)
      .join("\n\n");
    if (!this.summary) return recent;
    return `# 统一滚动摘要\n${this.summary}${recent ? `\n\n# 摘要后的最近权威记录\n${recent}` : ""}`;
  }
}
