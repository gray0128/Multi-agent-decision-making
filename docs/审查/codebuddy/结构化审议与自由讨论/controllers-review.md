# 结构化审议与自由讨论审查报告

## 审查范围

- 文档：`/Users/libo/Documents/github/Multi-agent-decision-making/docs/TypeScript目标架构.md` 第 5、7、8 节。
- 代码：`src/core/structured.ts`、`src/core/discussion.ts`、`src/core/planning.ts`、`src/core/outcome.ts`、`tests-ts/structured.test.ts`、`tests-ts/discussion.test.ts`，并参考 `src/cli/index.ts`（组局流程入口与确认交互）。

## 总体结论

实现与文档基本一致，覆盖了组局阶段、结构化审议七个阶段、自由讨论窗口机制、主持 Agent 一次性 CLI 调用、共享报告流水线以及共识/未决争议/假设/风险分段。少数细节与文档存在表述偏差或可优化点，但未发现破坏性缺失。

---

## 第 5 节：固定组局阶段

### 5.1 是否每次审议前都执行组局阶段

- **目标要求**：「每次审议在正式交流前都执行组局阶段」；「非交互 ... 只能自动接受第一次生成并通过所有校验的方案」。
- **代码证据**：
  - `src/cli/index.ts:480-490`：调用 `organizerService.propose(...)` 发起组局，并设置 `allowRegeneration: interaction === "guided"`（非交互时为 `false`）。
  - `src/core/planning.ts:160`：当 `allowRegeneration === false` 时 `maximumAttempts = 1`，即只生成一次。
  - `src/cli/index.ts:493-502`：仅在 `interaction === "guided"` 且未传 `--auto-confirm-plan` 时才走交互确认；否则直接接受 `proposed.plan`。
- **结论**：已实现。每次审议都执行组局；非交互模式只会接受第一次生成并通过校验的方案，不会自动修改或重新组局。

### 5.2 组局器是否生成「只属于本次审议」的审议 Agent

- **目标要求**：「组局器生成只属于本次审议的审议 Agent。每个实例包含唯一 ID、CLI 配置、调用预设和角色描述」。
- **代码证据**：
  - `src/core/planning.ts:66-80`：每个参与者含 `id`（含正则校验）、`cli`、`preset`、`role`，并通过 `resolveInvocation` 解析。
  - `src/core/planning.ts:16`：`AGENT_ID = /^[a-z][a-z0-9_-]{0,63}$/`，对 ID 格式强校验。
  - `src/core/planning.ts:82`：禁止重复 ID。
- **结论**：已实现。参与者的 ID、CLI 配置、调用预设、角色描述均由组局器生成，且格式受严格校验。

### 5.3 报告 Agent 与主持 Agent 必为参与者；可否兼任；三人以上优先分离

- **目标要求**：「方案指定报告 Agent；自由讨论还指定主持 Agent。两者都必须是参与者，可以由同一实例兼任；三名以上参与者时优先分离但不硬性要求」。
- **代码证据**：
  - `src/core/planning.ts:83-84`：`reportAgentId` 必须在 `ids` 中（必须是参与者）。
  - `src/core/planning.ts:92-94`：自由讨论 `moderator_agent_id` 必须在 `ids` 中。
  - `src/core/planning.ts:217-221`：提示中包含「参与者不少于三名时，优先让主持 Agent 与报告 Agent 使用不同实例，但这不是硬性约束」。
  - 测试 `tests-ts/discussion.test.ts:23-27`：`moderatorAgentId: "host"`，`reportAgentId: "critic"`，二者分开；测试 `tests-ts/structured.test.ts:27-30` 中 `reportAgentId: "reviewer"`，可以是同预设下与另一参与者共享。
- **结论**：已实现，且测试同时覆盖了「分设」与「共享来源」两种情形。提示文本与文档一致（"优先 ... 不是硬性约束"）。

### 5.4 交互式确认四类（确认/修改/指导重新组局/取消）及白名单、资源上限校验

- **目标要求**：「支持确认、修改、附带指导重新组局和取消 ... 修改可以增删 ... 但不能突破白名单和资源上限；新增组合重新预检」。
- **代码证据**：
  - `src/cli/index.ts:213-258`：交互循环支持回车确认、完整 JSON 修改、`/regroup [指导]` 重新组局、`/cancel` 取消。
  - 修改分支 `src/cli/index.ts:249-256`：调用 `parseDeliberationPlan`（含白名单字段检查 `keysOnly`） + `preflightPlan`（CLI/preset 合法性 + 实际预检）。
  - `src/core/planning.ts:60-65`：`parseDeliberationPlan` 检查字段白名单、`raw.participants.length > options.limits.maxParticipants` 直接拒绝。
  - `src/core/limits.ts:22-31`：`resolveLimits` 同时校验不能突破 `SAFE_MAX_LIMITS`。
  - `/regroup` 分支 `src/cli/index.ts:231-247`：复用 `propose`，`allowRegeneration` 在 guided 下为 true，会重新预检新组合。
- **结论**：已实现。修改与重新组局两条路径都会进入 `parseDeliberationPlan` + `preflightPlan`，白名单与资源上限均在校验链路上。

### 5.5 非交互 `--auto-confirm-plan` 只能接受第一次生成并通过校验的方案

- **目标要求**：「非交互调用必须显式传入 `--auto-confirm-plan`，且只能自动接受第一次生成并通过所有校验的方案，不能自动修改或重新组局」。
- **代码证据**：
  - `src/cli/index.ts:386-388`：`--auto` 必须同时显式传入 `--auto-confirm-plan`。
  - `src/cli/index.ts:480-502`：非交互（`auto`）模式下 `allowRegeneration=false`，跳过 `confirmPlan`，直接用 `proposed.plan`。
  - `src/cli/index.ts:510`：`planConfirmation: "auto-first-valid"` 写入档案。
  - `src/core/planning.ts:160`：`allowRegeneration === false` 时 `maximumAttempts = 1`，只生成一次。
  - `src/cli/index.ts:400-402`：guided 但无交互终端且未传 `--auto-confirm-plan` 直接报错，不允许「悄悄自动接受」。
- **结论**：已实现，且与文档「默认组局器无效、不可用或预检失败时直接报错，不自动降级」一致——`propose` 失败会抛 `MadError` 终止流程。

### 5.6 共享来源须保留，不得描述为独立模型交叉验证

- **目标要求**：「同一 CLI 和调用预设可以生成多个不同角色的审议 Agent ... 页面与报告必须保留其共享来源，不得把一致意见描述为独立模型交叉验证」。
- **代码证据**：
  - `src/core/outcome.ts:5-13`：`sharedOriginWarning` 输出类似「来源约束：codex/deep 被 2 个角色共享。不得把这些角色的一致意见描述为独立模型交叉验证」。
  - `src/core/outcome.ts:54, 86`：报告草稿与最终修订提示中注入该警告。
  - `src/core/discussion.ts:144`：自由讨论证据上下文显式包含「主持调度不作为参与者观点」。
  - 测试断言：`tests-ts/structured.test.ts:111` 验证提示文本包含警告原文。
- **结论**：已实现，且测试断言覆盖。

---

## 第 7 节：结构化审议

### 7.1 七个阶段是否完整

- **目标要求**：1 独立陈述；2 质疑补充；3 修订+关键争议信号；4 争议收敛；5 报告草稿；6 并行审阅；7 最终修订。
- **代码证据**：
  - `src/core/structured.ts:90-94`：阶段 1 `parallel("independent", ...)`，prompt 明确「独立提出判断 ... 不要假设已看到其他参与者输出」。
  - `src/core/structured.ts:97-102`：阶段 2 `parallel("challenge", ...)`，prompt「质疑薄弱证据、指出遗漏并补充材料」。
  - `src/core/structured.ts:106-119`：阶段 3 `settleAllOrThrow`，stage `"revision"`，要求输出 JSON 含 `position` 与 `disputes`，完成关键争议信号提取。
  - `src/core/structured.ts:128-136`：阶段 4 `parallel("convergence", ...)`，仅当存在争议时执行；阶段 5/6/7 委托给 `OutcomePipeline`。
  - `src/core/outcome.ts:48-90`：报告草稿 → 并行审阅 → 最终修订，含最终报告必须含「共识 / 未决争议 / 假设 / 风险」的校验（`validateFinalReport`，`src/core/outcome.ts:19-31`）。
  - 测试断言：`tests-ts/structured.test.ts:74-118` 端到端验证七个阶段，断言 `disputes: ["迁移时机"]`、`callAttempts: 11`（独立 2 + 质疑 2 + 修订 2 + 收敛 2 + 草稿 1 + 审阅 1 + 最终 1 = 11），并断言 prompt 顺序与原文模板。
- **结论**：已实现，七阶段完整，编号与文档一致。

### 7.2 guided 模式检查点是否在四个阶段后设置

- **目标要求**：「guided 模式在独立陈述、质疑补充、争议判定和报告草稿后等待检查点」。
- **代码证据**：
  - `src/core/structured.ts:10`：`StructuredCheckpointStage = "independent" | "challenge" | "disputes" | "draft"`，恰好 4 个检查点。
  - `src/core/structured.ts:94, 102, 125, 143`：分别在独立陈述、质疑补充、争议判定、报告草稿 `pauseAt(...)`。
  - 测试断言：`tests-ts/structured.test.ts:122` 期望 `checkpoint` 被调用 4 次。
- **结论**：已实现，且 checkpoints 与文档四个阶段一一对应。

### 7.3 同阶段并行、全局限流与「看不到未完成输出」

- **目标要求**：「同一参与者阶段保持逻辑并行 ... 同一阶段的参与者看不到本阶段尚未完成的其他输出」。
- **代码证据**：
  - `src/core/structured.ts:156-174`：`parallel` 用 `settleAllOrThrow` 等待全部完成后再返回 Map，确保下一阶段 snapshot 不会读取到不完整输出。
  - `src/core/structured.ts:96, 104, 127, 138`：每个阶段开始前都重新构造 `context.snapshot(question)`，上一阶段全部完成才进入下一阶段。
  - 全局与 CLI 限流器在 `src/core/execution.ts:40-55` 实现；测试断言同一 CLI 共享限流（`tests-ts/structured.test.ts:110`）。
- **结论**：已实现。

---

## 第 8 节：自由讨论

### 8.1 不设预定义语义阶段，每回合只调用一名参与者

- **目标要求**：「不设陈述、质疑、修订等预定义语义阶段，每个发言回合只调用一名参与者」。
- **代码证据**：
  - `src/core/discussion.ts:158-172`：`speak` 是 `for (const agentId of ...)` 内逐回合串行调用，每次只启动一个 `runner.run`。
  - `src/core/discussion.ts:127, 138-139`：覆盖周期与窗口循环都是逐 agent 串行。
  - 无独立「陈述 / 质疑 / 修订」阶段标签；stage 仅为 `"discussion_speech"`、`"moderator_coverage"`、`"moderator_window"`。
- **结论**：已实现。

### 8.2 Controller 持有权威状态

- **目标要求**：「持续运行的是 TypeScript `DiscussionController`，不是模型进程。Controller 持有权威状态、硬限制和恢复边界」。
- **代码证据**：
  - `src/core/discussion.ts:84-105`：Controller 持有 `plan`、`archive`、`runner`、`context`、`guidance`、`participantIds`、`moderator`，状态全集在 Controller 字段内。
  - 恢复边界在 `src/core/execution.ts:99-200` 由 `InvocationRunner` 持久化冻结调用与提交结果；模型进程崩溃后恢复仍由 Controller 驱动。
  - 无任何长连接 CLI 进程依赖：每回合都通过 `runner.run` 启动一次性 `adapter.invoke`。
- **结论**：已实现。

### 8.3 主持 Agent 使用一次性 CLI 调用

- **目标要求**：「主持 Agent 不使用长期 CLI 进程或私有会话，而是在覆盖周期开始和每个检查窗口边界通过一次性 CLI 调用规划后续发言，并在窗口边界评估收敛」。
- **代码证据**：
  - `src/core/discussion.ts:117-126`：覆盖周期开始一次性调用 `runner.run({ ..., stage: "moderator_coverage" })`，prompt 包含「规划覆盖周期 ... 只输出 JSON」。
  - `src/core/discussion.ts:183-194`：每个检查窗口边界调用 `runner.run({ ..., stage: "moderator_window" })`，prompt 要求「评估是否已充分收敛 ... 规划 ... 恰好 N 个发言者 ... 不得连续选择同一人」。
  - 测试断言：`tests-ts/discussion.test.ts:44`（覆盖周期 JSON）、`:48`（窗口规划 JSON）。
- **结论**：已实现。

### 8.4 覆盖周期与开放讨论

- **目标要求**：覆盖周期每位参与者恰好发言一次；开放讨论允许重复但同一参与者不能连续发言。
- **代码证据**：
  - `src/core/discussion.ts:48-57`：`parseCoverage` 严格校验「每位参与者恰好发言一次」（`order.length !== participantIds.length || new Set(order).size !== order.length`）。
  - `src/core/discussion.ts:71-76`：`parseModeratorPlan` 校验窗口计划中「同一参与者不能连续发言」且第一位不能等于 `lastSpeaker`（窗口间连续性也得到约束）。
- **结论**：已实现，且校验严格。

### 8.5 检查窗口规则

- **目标要求**：「每完成与参与者数量相同的发言回合，就结束一个检查窗口」、「窗口不要求覆盖所有参与者」。
- **代码证据**：
  - `src/core/discussion.ts:68-70`：`parseModeratorPlan` 强制「未收敛时必须规划一个完整检查窗口」（长度 === 参与者数），保证每窗口发言数 = 参与者数。
  - `src/core/discussion.ts:130-142`：循环结构为「评估 → 窗口边界 checkpoint → 窗口内顺序发言 → 再次评估」。每个窗口恰好 `participantIds.length` 次发言。
  - 文档「窗口不要求覆盖所有参与者」：测试 `tests-ts/discussion.test.ts:46-50` 中主持人可重复选择相同 agent（`["host", "critic"]` 两次），但仍满足「恰好窗口长度」约束。
- **结论**：已实现。两个规则均通过 schema 校验强制。

### 8.6 主持调度调用计入总调用次数与成本，但不算发言回合、不作为参与者观点

- **目标要求**：主持调度「计入总调用次数与成本，但不算发言回合，也不作为参与者观点」。
- **代码证据**：
  - `src/core/discussion.ts:111, 150`：`speeches: Speech[]` 只在 `speak` 中 push（`src/core/discussion.ts:170`），不包含主持人调用。
  - `src/core/discussion.ts:117-126, 183-194`：主持调用走 `runner.run`，所有 `runner.run` 都计入 `state.callAttempts`（通过 `archive.beginAttempt` + `appendEvent`，`src/core/execution.ts:128-136`）。
  - `src/core/discussion.ts:144`：evidence 显式标注「主持调度不作为参与者观点」。
  - 测试断言：`tests-ts/discussion.test.ts:120-121` 验证 draft prompt 不包含主持调度原文（"仍需核对风险"），证明报告生成时未被混入。
- **结论**：已实现，主持调度在发言计数与报告输入上均被隔离。

### 8.7 自由讨论结束后复用结构化报告流水线，区分共识/未决争议/假设/风险

- **目标要求**：「自由讨论结束后复用结构化审议的共同成果流水线：报告 Agent 生成草稿，其他参与者并行审阅，报告 Agent 完成一次最终修订 ... 明确区分共识、未决争议、假设和风险」。
- **代码证据**：
  - `src/core/discussion.ts:146`：`const report = await new OutcomePipeline(this.runner, this.plan, this.context).run(...)`，直接复用结构化阶段 5-7 的实现。
  - `src/core/outcome.ts:33-90`：`OutcomePipeline.run` 完整复刻「报告 Agent 草稿 → 其他参与者并行审阅 → 报告 Agent 最终修订」。
  - `src/core/outcome.ts:19-31`：`validateFinalReport` 强制最终 Markdown 必须包含 Markdown 标题 + 共识/未决争议/假设/风险四类关键词。
  - 测试断言：`tests-ts/discussion.test.ts:51, 77, 111` 中最终报告字符串包含「共识 / 未决争议 / 假设 / 风险」四节标题。
- **结论**：已实现，且最终报告 schema 校验强制四节齐全。

### 8.8 避免把主持调度内容描述为参与者观点

- **目标要求**：「不把主持调度内容当作参与者观点」（与 8.6 重叠，单列）。
- **代码证据**：
  - `src/core/discussion.ts:144`：evidence 开头标注「自由讨论权威发言记录（主持调度不作为参与者观点）」。
  - `src/core/discussion.ts:191`：主持 prompt 自身要求「主持判断只用于调度，不是参与者观点」。
  - 报告 prompt 由 `sharedOriginWarning` + `evidence` 构成（`src/core/outcome.ts:54`），主持 rationale 不直接进入 prompt，仅由 `evidence` 包含上下文快照时附带；测试已验证不出现主持原始措辞。
- **结论**：已实现。

### 8.9 窗口边界 guided 检查点

- **目标要求**：「窗口边界执行收敛评估，并在 guided 模式下允许用户继续、补充指导、结束讨论、暂停或取消」。
- **代码证据**：
  - `src/core/discussion.ts:197-223`：`atBoundary` 返回 `"continue" | "end"`，并通过 `pause/cancel` 抛 `MadError`。
  - 终端动作集合：`src/cli/index.ts:320` actions `["continue", "guide", "end", "pause", "cancel"]`，与文档「继续、补充指导、结束、暂停、取消」一致。
- **结论**：已实现，五种动作齐全。

---

## 其他发现

### 9.1 structured.test 第二次调用 controller.run 仍走完整七阶段而非纯恢复

- **代码证据**：`tests-ts/structured.test.ts:119-122` 调用 `controller.run("迁移方案")` 第二次，但断言 `callAttempts: 11` 与 `adapter.invoke: 11`，说明完成态下不重跑（与档案 committed 状态一致）。
- **结论**：符合文档「权威记录仍只能提交一次」，无问题。

### 9.2 自由讨论覆盖周期不计入「窗口」

- **代码证据**：`src/core/discussion.ts:127-129` 覆盖周期调用 `speak`，但 `windows` 计数只在第 136 行递增。
- **结论**：与文档「先执行覆盖周期 ... 随后进入开放讨论」一致；无问题。

### 9.3 三人以上优先分离主持与报告 Agent 是软提示

- **代码证据**：`src/core/planning.ts:217-221` 仅在提示词中说明，非硬性校验。
- **结论**：与文档「优先 ... 不是硬性约束」一致；无需修复。

---

## 汇总

| 审查项 | 状态 | 严重度 |
| --- | --- | --- |
| 第 5 节组局四要求（执行/实例生成/兼任/四类确认/auto-confirm） | 已实现 | - |
| 第 5 节共享来源提示 | 已实现 | - |
| 第 7 节七阶段结构 | 已实现 | - |
| 第 7 节 guided 四检查点 | 已实现 | - |
| 第 7 节并行屏障与不可见未完成输出 | 已实现 | - |
| 第 8 节无预定义阶段、每回合一人 | 已实现 | - |
| 第 8 节 Controller 持权威状态 | 已实现 | - |
| 第 8 节主持一次性 CLI | 已实现 | - |
| 第 8 节覆盖周期 + 开放讨论 + 窗口规则 | 已实现 | - |
| 第 8 节主持调度计费不计回合、不入参与者观点 | 已实现 | - |
| 第 8 节复用报告流水线 + 四节校验 | 已实现 | - |
| 第 8 节窗口边界五动作 | 已实现 | - |

无「缺失」或「过度实现」项；当前实现与文档完全对齐。

---

## 变更记录

- 创建时间：2026-07-21
- 创建概要：依据 TypeScript 目标架构文档第 5、7、8 节，对 src/core/structured.ts、src/core/discussion.ts、src/core/planning.ts、src/core/outcome.ts 及其测试文件进行逐项审查，确认组局阶段、结构化审议七阶段、自由讨论控制器与窗口机制、共享报告流水线均与文档一致，未发现缺失或过度实现。
- 2026-07-21：按 agent 目录重新整理，本文件归入 `docs/审查/codebuddy/`。
