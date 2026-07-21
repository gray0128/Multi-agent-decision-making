import type { CliRegistry } from "../adapters/config.js";
import { resolveInvocation } from "../adapters/config.js";
import { MadError } from "./errors.js";
import type { InvocationRunner } from "./execution.js";
import type { DeliberationPlan } from "./types.js";
import { estimateTokens } from "./tokens.js";

export { estimateTokens } from "./tokens.js";

interface ContextEntry {
  readonly label: string;
  readonly content: string;
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

  public async snapshot(question: string, reserveTokens = 0): Promise<string> {
    if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 0) {
      throw new MadError("EXECUTION", "上下文预留预算必须是非负整数");
    }
    const availableForContext = this.contextBudget - reserveTokens;
    if (availableForContext < 32) throw new MadError("EXECUTION", "固定提示已经占满上下文预算");
    const current = this.renderCurrent();
    const targetTokens = Math.max(32, Math.min(Math.floor(this.contextBudget * 0.45), availableForContext));
    if (estimateTokens(current) <= targetTokens) return current;
    const reportAgent = this.plan.participants.find((participant) => participant.id === this.plan.reportAgentId);
    if (!reportAgent) throw new MadError("EXECUTION", "报告 Agent 不存在，无法生成统一滚动摘要");
    const through = this.entries.length;
    const summaryHeaderTokens = estimateTokens("# 统一滚动摘要\n");
    const sourceTargetTokens = Math.max(16, targetTokens - summaryHeaderTokens);
    const maximumCharacters = Math.max(
      32,
      Math.floor(Math.min(this.contextBudget * 0.1, sourceTargetTokens) * 4),
    );
    let source = current;
    for (let round = 0; estimateTokens(source) > sourceTargetTokens; round += 1) {
      if (round >= 12) throw new MadError("EXECUTION", "滚动摘要无法压缩到上下文预算内");
      const prefix = `你是报告 Agent ${reportAgent.id}。为所有参与者压缩一段权威记录。\n问题：${question}\n` +
        `保留身份、证据、立场、争议、假设、风险和任务约束；不加入新判断；不得把共享来源说成独立模型验证。` +
        `输出不超过 ${maximumCharacters} 个字符。\n`;
      const availableTokens = this.contextBudget - estimateTokens(prefix) - 16;
      if (availableTokens < 32) throw new MadError("EXECUTION", "问题和摘要指令已经超过上下文预算");
      const chunkCharacters = availableTokens * 4;
      const chunks: string[] = [];
      for (let offset = 0; offset < source.length; offset += chunkCharacters) {
        chunks.push(source.slice(offset, offset + chunkCharacters));
      }
      const partials: string[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const result = await this.runner.run({
          id: `context:summary:${this.summarizedEntries}:${through}:r${round}:c${index}`,
          kind: "summary",
          agentId: reportAgent.id,
          invocation: reportAgent.invocation,
          stage: "context_summary",
          prompt: `${prefix}片段 ${index + 1}/${chunks.length}：\n${chunks[index]}`,
          parse: (text) => {
            const value = text.trim();
            if (!value) throw new Error("滚动摘要为空");
            if (value.length > maximumCharacters) throw new Error(`滚动摘要超过 ${maximumCharacters} 字符`);
            return value;
          },
        });
        partials.push(result.value);
      }
      source = partials.map((value, index) => `## 摘要片段 ${index + 1}\n${value}`).join("\n\n");
    }
    this.summary = source;
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
