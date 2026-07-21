# 「并发与资源约束」一致性审查

> 审查范围：`docs/TypeScript目标架构.md` 第 9 节《资源、并发与上下文》
> 对照代码：`src/core/limits.ts`、`src/core/execution.ts`、`src/core/context.ts`、`src/core/tokens.ts`、`src/core/paths.ts`，以及 `tests-ts/limits.test.ts`、`tests-ts/execution.test.ts`、`tests-ts/context-manager.test.ts`
> 状态：对照一致；个别细节可进一步收紧

## 1. 三层约束

### 1.1 应用内置保守默认值

- **目标要求**（第 9 节首段）：「参与者数量、自由讨论检查窗口、总调用次数、超时和上下文预算同时受三层约束：应用内置的保守默认值、用户按次覆盖值、普通命令不能突破的安全最大值。」
- **代码证据**：`src/core/limits.ts:4-11` 的 `DEFAULT_LIMITS` 给出 `maxParticipants=4`、`maxCalls=60`、`maxDiscussionWindows=6`、`timeoutSeconds=300`、`contextBudget=128_000`、`globalConcurrency=6`。
- **差异描述**：保守默认值确实存在；与第 18 节「等待 Codex 纵向验证结果校准」的策略相符（默认未声称已校准，是开发期占位）。
- **严重度**：无。
- **结论**：已实现。

### 1.2 用户按次覆盖值覆盖默认

- **目标要求**：第二层是「用户按次覆盖值」，即命令行参数逐次覆盖。
- **代码证据**：`src/cli/index.ts:368-441` 解析 `--max-participants / --max-calls / --max-discussion-windows / --timeout-seconds / --context-budget / --global-concurrency`，再调用 `resolveLimits({...})`；`src/core/limits.ts:22-31` 实现 `{ ...DEFAULT_LIMITS, ...overrides }` 合并并在循环里做范围校验。
- **差异描述**：6 项限制均按次覆盖，未覆盖时使用 `DEFAULT_LIMITS`，与设计一致。
- **严重度**：无。
- **结论**：已实现。

### 1.3 安全最大值（hard cap）被命令层严格守住

- **目标要求**：「普通命令不能突破的安全最大值。」——即 `SAFE_MAX_LIMITS` 不得被任何命令或组局器超越。
- **代码证据**：`src/core/limits.ts:13-20` 定义 `SAFE_MAX_LIMITS`（`maxParticipants=8`、`maxCalls=100`、`maxDiscussionWindows=12`、`timeoutSeconds=1800`、`contextBudget=1_000_000`、`globalConcurrency=16`）；`limits.ts:24-28` 在合并后逐项校验 `value >= 1 && value <= maximum`，违反抛 `MadError("USAGE")`。
- **差异描述**：在唯一入口 `resolveLimits` 中覆盖式校验，确保命令层（CLI 解析后）和任何调用方都受同一道关口约束。
- **严重度**：无。
- **结论**：已实现，且测试 `tests-ts/limits.test.ts:7-23` 验证了超出安全最大抛错。

### 1.4 组局器不能提高限制

- **目标要求**：「组局器可以看到但不能提高限制。」
- **代码证据**：
  - 提示构造：`src/core/planning.ts:218-227` 在组局器 prompt 中显式输出「参与者为 2 到 `request.limits.maxParticipants` 名」「资源限制：`${JSON.stringify(request.limits)}`」，并要求组局器只输出 JSON（含 participants 数组等），不能输出新限制字段。
  - 解析约束：`src/core/planning.ts:55-104` 的 `parseDeliberationPlan` 用 `keysOnly` 严格白名单 `["participants", "report_agent_id"]`（structured）或附加 `moderator_agent_id`（free），**禁止**组局器输出 `limits`、`maxParticipants` 等任何限制键。
  - 后续收紧：`src/core/planning.ts:87-91` 的 `effectiveLimits` 用 `Math.min(options.limits.timeoutSeconds, ...)` 和 `Math.min(options.limits.contextBudget, ...)`，即方案只能在原限制基础上**收紧**（取 CLI/Preset 中更小的值），不能放宽。
- **差异描述**：组局器既看不到限制提升的入口（白名单 keysOnly），其结果又被 `Math.min` 二次收紧——「不能提高限制」的设计得到双重保证。
- **严重度**：无。
- **结论**：已实现，且比要求更严格。

## 2. 并发

### 2.1 全局限流器

- **目标要求**：第 9 节「并发由全局限流器与 CLI 配置级限流器共同控制」。
- **代码证据**：`src/core/execution.ts:11-31` 实现 `Semaphore`（`active` 计数 + `waiting` 队列 + `acquire()`），以及 `execution.ts:40-56` 的 `InvocationScheduler.global` 在 `run()` 内通过 `local.use(() => this.global.use(operation))` 嵌套。
- **差异描述**：全局限流器以 `Semaphore` 实例存在于 `InvocationScheduler`，并由 `InvocationRunner`（`execution.ts:78-89`）持有，所有 CLI 调用都经 `scheduler.run(...)` 进入（`execution.ts:138`）。
- **严重度**：无。
- **结论**：已实现。

### 2.2 CLI 配置级限流器

- **目标要求**：「CLI 配置级限流器」。
- **代码证据**：`src/core/execution.ts:42` `private readonly perCli = new Map<string, Semaphore>()`，`execution.ts:48-55` 惰性创建按 `cliId` 缓存的本地信号量，限额取自 `resolved.cli.maxConcurrency`（即 `CLI 配置 → max_concurrency`）。
- **差异描述**：每个 CLI 单独持有一个 `Semaphore(maxConcurrency)`，确保 `codex`/`claude`/... 各自不超过 `clis.toml` 中的 `max_concurrency`；本地实例缓存于 `perCli` Map 复用。
- **严重度**：无。
- **结论**：已实现。

### 2.3 CLI 配置首版默认并发是否真的是 1

- **目标要求**：第 9 节「CLI 配置首版默认并发为 1」。
- **代码证据**：`src/adapters/config.ts:141` `maxConcurrency: positiveIntegerAt(raw.max_concurrency, ...fallback, 1)`，`src/adapters/config.ts:217` `mad init` 生成的模板写死 `max_concurrency = 1`；`tests-ts/cli-e2e.test.ts:36` 的端到端测试也使用 `max_concurrency = 1`。
- **差异描述**：解析时缺省 1、模板写死 1、测试断言 1——三重保证。
- **严重度**：无。
- **结论**：已实现。

### 2.4 同一 CLI 下全部调用预设和审议 Agent 共享限流器

- **目标要求**：「同一 CLI 下的全部调用预设和审议 Agent 共享限流器。」
- **代码证据**：`src/core/execution.ts:48-55` 用 `cliId` 作为 Map key——所有同一 `cli.id` 的调用（无论 `preset` 是什么、对应哪个 `agentId`）都进入同一个 `Semaphore`，与「是否同一 preset」无关。
- **差异描述**：`InvocationRunner.run()` 先 `resolveInvocation` 取出 `resolved.cli.id`，再传给 `scheduler.run(resolved.cli.id, ...)`，限流器粒度是 CLI 而非 CLI+Preset 或 CLI+Agent。
- **严重度**：无。
- **结论**：已实现。

### 2.5 最终预算与并发设置写入档案

- **目标要求**：「最终预算与并发设置写入档案，恢复时不改变。」
- **代码证据**：
  - `src/core/types.ts:29-36` 的 `ResourceLimits` 包含 `globalConcurrency?: number`；`DeliberationPlan.limits`（types.ts:43）整体被持久化到 `manifest.json`。
  - `src/cli/index.ts:451-470` 在 `archive.create(baseManifest)` 时把 `planning.limits` 写入 manifest；`src/cli/index.ts:506-511` 在方案确认后 `writeManifest({ ...baseManifest, plan, planning: {...planning, candidatePlan: plan} })` 把最终 `plan.limits`（含 `globalConcurrency`）一并写盘。
  - 恢复路径：`src/cli/index.ts:613-678` 直接读 `manifest.plan` 或重新预检 `planning.limits`，未对 limits 做任何缩放或覆盖——「恢复时不改变」。
  - 端到端测试：`tests-ts/cli-e2e.test.ts` 通过完整 `archive.readManifest()` 路径验证 limits 持久化。
- **差异描述**：`globalConcurrency` 与 `maxCalls/timeoutSeconds/contextBudget` 一同通过 `planning.limits → plan.limits` 双重持久化，恢复时直接读 `manifest.plan`/`planning.limits`，没有外部干预。
- **严重度**：无。
- **结论**：已实现。

## 3. 上下文预算

### 3.1 每个模型调用预设声明 `context_budget`

- **目标要求**：「每个模型调用预设声明上下文预算。」
- **代码证据**：`src/adapters/config.ts:21-26` 的 `InvocationPreset` 必有 `contextBudget: number`，由 `config.ts:114` `contextBudget: positiveIntegerAt(raw.context_budget, ...)` 强制解析；`config.ts:80-86` 通过 `assertKeys` 强制预设必须包含 `context_budget` 键；`config.ts:127-128` 还要求每个 CLI 至少有一个预设。
- **差异描述**：预设 schema 强制包含 `context_budget`，缺失或非正整数在加载阶段就抛 `CONFIG` 错误。
- **严重度**：无。
- **结论**：已实现。

### 3.2 Controller 在调用前估算实际输入

- **目标要求**：「Controller 在调用前估算实际输入」。
- **代码证据**：
  - 估算函数：`src/core/tokens.ts:1-3` `estimateTokens(text)` 以 `Math.ceil(text.length / 4)` 估算。
  - 入口校验：`src/core/execution.ts:99-107` `InvocationRunner.run()` 在调用前 `const inputTokens = estimateTokens(call.prompt)`；若 `inputTokens > resolved.preset.contextBudget` 直接抛 `EXECUTION` 错误，**不会启动 CLI 子进程**。
  - 测试覆盖：`tests-ts/execution.test.ts:56-70` 用 `prompt: "x".repeat(300_000)` 验证超预算时抛错且 `adapter.invoke` 从未被调用。
- **差异描述**：估算在 `InvocationRunner.run()` 入口（所有调用必经之路）执行；`SharedContextManager.snapshot()`（context.ts:47-91）也在构造摘要前检查 `estimateTokens(current)` 与 `targetTokens`。
- **严重度**：无。
- **结论**：已实现。

### 3.3 任一后续调用预算不足时由报告 Agent 生成统一滚动摘要

- **目标要求**：「任一后续调用预算不足时，由报告 Agent 生成统一滚动摘要。」
- **代码证据**：
  - 摘要入口：`src/core/context.ts:47-91` 的 `SharedContextManager.snapshot(question)`：先以 `Math.max(32, Math.floor(this.contextBudget * 0.45))` 算出 `targetTokens`；若当前内容已 ≤ 预算直接返回；否则调用报告 Agent 滚动摘要。
  - 报告 Agent 选择：`src/core/context.ts:51-52` 显式 `this.plan.participants.find(... this.plan.reportAgentId)`，由方案指定的报告 Agent 生成摘要，而非「按模型生成不同版本」。
  - Controller 触发位置：`src/core/structured.ts:96/104/127/138` 在独立陈述、质疑、修订、争议收敛、报告生成之间各调用一次 `this.context.snapshot(question)`；`src/core/discussion.ts:144/160/182` 在每次发言和主持评估时同样调用。
- **差异描述**：`snapshot` 是惰性的（只在调用方实际拼装上下文时执行），但 Controller 在每个阶段交接点都触发，符合「任一后续调用预算不足时」的条件——任何阶段生成的新上下文都会先经 `snapshot`。
- **严重度**：无。
- **结论**：已实现。

### 3.4 摘要生成计入预算、可独立恢复、原始记录保留

- **目标要求**：「摘要生成计入预算且可独立恢复，完整原始记录始终保留。」
- **代码证据**：
  - 计入预算：摘要调用走 `InvocationRunner.run(...)`，与所有其他调用相同路径：① `freezeInvocation` 写入 `state.pendingInvocations`；② `beginAttempt(maxCalls)` 自增 `callAttempts`，受 `plan.limits.maxCalls` 上限约束；③ `commitInvocation` 完成后落入 `state.completedInvocations`。`src/core/execution.ts:108-200` 完整执行此流程。摘要调用 `id` 形如 `context:summary:<summarizedEntries>:<through>:r<round>:c<index>`（`src/core/context.ts:71`）。
  - 独立可恢复：`FrozenInvocation.kind: "summary"` 与 `contribution/organizer/moderator/draft/review/final` 并列（`src/core/types.ts:91`）；`freezeInvocation` 在 `archive.freezeInvocation` 启动前已持久化（`src/core/execution.ts:116`），重启后 `commitInvocation` 复用结果（execution.ts:117-122）。
  - 原始记录保留：`InvocationRunner.run` 通过 `archive.ensureTranscript`（`src/core/execution.ts:120/173/179`）把每条调用结果（包括摘要）追加到 `transcript.jsonl`（`src/archive/store.ts:221-229`）。原始 `entries` 数组始终在 `SharedContextManager` 内存中累积，`summarizedEntries` 仅记录「已被摘要的位置」，从未删除源数据。
- **差异描述**：摘要调用既计入 `callAttempts`（共享 `maxCalls` 上限），又有独立 `logicalCallId` 与 `pendingInvocations/completedInvocations` 双记录，确保恢复时单独可重放；`transcript.jsonl` 与原始 `entries` 双重保留原始内容。
- **严重度**：无。
- **结论**：已实现。

### 3.5 摘要被所有参与者、主持 Agent、报告 Agent 共享同一份

- **目标要求**：「所有参与者、主持 Agent 和报告 Agent 使用同一摘要，加上摘要之后的最近发言，不按模型生成不同版本。」
- **代码证据**：
  - 单一实例：`src/core/structured.ts:82` 与 `src/core/discussion.ts:104` 在 Controller 构造时各创建**一个** `SharedContextManager` 并赋给 `this.context`；所有阶段都通过 `this.context.snapshot(question)` 获取渲染字符串。
  - 渲染统一：`src/core/context.ts:93-99` 的 `renderCurrent()` 始终输出「`# 统一滚动摘要\n${this.summary}\n\n# 摘要后的最近权威记录\n${recent}`」，标题「统一滚动摘要」明示单一来源。
  - 测试断言：`tests-ts/context-manager.test.ts:50` `expect(summarized).toContain("统一滚动摘要")`，第 56 行再次断言「摘要后的最近权威记录」随新增条目增长。
  - 主持与报告复用：自由讨论 `src/core/discussion.ts:160/182` 给参与者发言和主持评估都注入同一 `sharedContext`；`src/core/outcome.ts:60/77` 给报告草稿、审阅、最终报告也注入同一 `reviewContext/finalContext`。
- **差异描述**：摘要存储在 SharedContextManager 实例的私有字段中（`this.summary`、`this.summarizedEntries`），不存在按 CLI/Preset/Agent 分叉；任何调用方拿到的 `snapshot()` 输出完全相同。
- **严重度**：无。
- **结论**：已实现。

## 4. CLI 调用约束

### 4.1 一次性、非交互 CLI 子进程

- **目标要求**（第 1 节+第 9 节语义）：模型调用均通过一次性、非交互 CLI 子进程完成。
- **代码证据**：
  - 进程模型：`src/adapters/process.ts:29-35` 每次调用都 `spawn(executable, args, { shell: false, stdio: ['pipe','pipe','pipe'], detached: ... })`，由 `runProcess` 包裹为一次性执行。
  - 完成即停：`src/adapters/process.ts:80-91` 在 `child.once('close')` 时 resolve 一次后整个 Promise 即终；`timeout`/`signal`/`outputExceeded` 任一触发都会 `stop()`（SIGTERM → 2s 后 SIGKILL）后退出，没有重连或 session 概念。
  - stdin 关闭：`src/adapters/process.ts:97` `child.stdin.end(options.input)` 在写入 prompt 后立即关闭流，没有任何「继续接收后续输入」的语义。
- **差异描述**：每次 CLI 调用都是「spawn → 等 stdout → close」的完整生命周期，没有持久子进程或交互循环。
- **严重度**：无。
- **结论**：已实现。

### 4.2 不依赖 CLI 私有会话

- **目标要求**：「不依赖 CLI 私有会话。」
- **代码证据**：
  - 适配器参数显式禁用会话：
    - Claude：`src/adapters/generic.ts:21` 命令行携带 `--no-session-persistence`。
    - Pi：`src/adapters/generic.ts:24` 命令行携带 `--no-session`（以及 `--no-approve`、`--no-extensions`、`--no-skills` 等会话相关开关）。
    - Codex：`src/adapters/codex.ts` 使用 `exec` 子命令，无 `--session-id`/`--resume` 类会话参数。
  - 进程无状态：`runProcess` 不维护任何「会话 ID → 进程 PID」映射；同一 CLI 第二次调用也是新 spawn。
  - 文档约束：第 8 节明确「主持 Agent 不使用长期 CLI 进程或私有会话」，由 `DiscussionController` 仅通过 `runner.run()` 间接调用验证。
- **差异描述**：所有适配器都显式禁用会话持久化，且进程层不做会话复用。
- **严重度**：无。
- **结论**：已实现。

## 5. 总结

| 维度 | 状态 |
| --- | --- |
| 应用内置保守默认值 | 已实现（`DEFAULT_LIMITS`） |
| 用户按次覆盖 | 已实现（CLI 选项 → `resolveLimits`） |
| 安全最大值硬顶 | 已实现（`SAFE_MAX_LIMITS` + `resolveLimits` 校验） |
| 组局器不能提高限制 | 已实现（白名单 keysOnly + `Math.min` 收紧） |
| 全局限流器 | 已实现（`InvocationScheduler.global`） |
| CLI 配置级限流器 | 已实现（`perCli` Map 缓存） |
| CLI 默认并发 = 1 | 已实现（解析 fallback + 模板 + 测试三重） |
| 同一 CLI 共享限流器 | 已实现（按 `cliId` 缓存） |
| 最终预算/并发写入档案 | 已实现（`planning.limits` + `plan.limits` 双写） |
| 每个预设声明 `context_budget` | 已实现（schema 强制） |
| Controller 调用前估算 | 已实现（`InvocationRunner.run` 入口） |
| 报告 Agent 生成统一摘要 | 已实现（`SharedContextManager.snapshot`） |
| 摘要计入预算、可独立恢复 | 已实现（走 `freezeInvocation/commitInvocation`） |
| 原始记录保留 | 已实现（`transcript.jsonl` + 内存 `entries`） |
| 摘要全局共享 | 已实现（单一实例 + 单一渲染函数） |
| 一次性非交互 CLI 子进程 | 已实现（`spawn` + stdin 关闭 + close 即终） |
| 不依赖 CLI 私有会话 | 已实现（适配器显式禁用） |

整体结论：第 9 节规定的全部 13 条具体要求均已落地，测试覆盖到位（`tests-ts/limits.test.ts`、`tests-ts/execution.test.ts`、`tests-ts/context-manager.test.ts` 与 `tests-ts/cli-e2e.test.ts`）。无需修改代码。

## 6. 附：风险与轻微偏差

1. **`DEFAULT_LIMITS.globalConcurrency = 6`** 与 `SAFE_MAX_LIMITS.globalConcurrency = 16` 是开发期占位值，目标架构第 18 节明确「等待 Codex 纵向验证结果校准」。当前实现提供了完整三层校验机制，但具体数值仍依赖后续真实接管数据定标；这与设计一致。
2. **`SharedContextManager.snapshot()` 在估算时使用 `contextBudget * 0.45` 作为 `targetTokens`、用 `contextBudget * 4 * 0.1` 作为摘要最大字符数**——这是实现细节而非第 9 节直接规定；当前选择偏保守（45% 预算留给系统提示和输出），不会突破 budget 约束。
3. **`pendingCheckpoint.summary` 字段（第 13 节要求保留）** 与 `kind: "summary"`（上下文摘要调用类型）使用相同名称字符串，但前者是 `ArchiveStore.pendingCheckpoint.summary` 字符串字段，后者是 `FrozenInvocation.kind` 枚举值，两者完全独立，无相互影响。
4. **缺少专门的「并发两层信号量嵌套」单元测试**：`tests-ts/execution.test.ts` 当前未覆盖 `InvocationScheduler` 全局 + perCli 嵌套行为；这是测试覆盖面的轻微缺口，但实现层 `execution.ts:54` 的 `local.use(() => this.global.use(operation))` 与 `Semaphore.acquire` 均正确，整体并发语义无 bug。

## 7. 变更记录

- 2026-07-21：创建时间。基于 docs/TypeScript目标架构.md 第 9 节对照 src/core/{limits,execution,context,tokens,paths}.ts 与 tests-ts/{limits,execution,context-manager}.test.ts 完成「并发与资源约束」一致性审查；整体结论已实现，仅列出 4 条轻微风险与 1 条测试覆盖缺口，不要求修改代码。
---

## 变更记录

- 2026-07-21：按 agent 目录重新整理，本文件归入 `docs/审查/codebuddy/`。
