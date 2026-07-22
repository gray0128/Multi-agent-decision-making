# 分册 #2：核心审议审查报告

**审查范围**：`src/core/` 下实现，对照 `docs/TypeScript目标架构.md` §5（固定组局阶段）、§7（结构化审议）、§8（自由讨论）、§9（资源、并发与上下文）。
**审查方式**：使用 CodeGraph 工具逐文件核对实现语义，独立完成，不参考其他审查报告。

---

## 1. 对照章节与文件映射

| 架构章节 | 关键内容 | 主要实现文件 | 关键符号 |
| --- | --- | --- | --- |
| §5 固定组局阶段 | 默认组局器、CLI 注册表安全视图、参与者定义、运行时预检、白名单修改约束、共享来源 | `src/core/planning.ts` | `OrganizerService`、`parseDeliberationPlan`、`preflightPlan`、`buildPrompt`、`requireProjectReadOnly`、`requireReady` |
| §5/§7/§8 检查点协议 | 检查点动作枚举（continue/pause/cancel/guide/end）、记忆持久化、第一份响应获胜 | `src/core/structured.ts` `src/core/discussion.ts` `src/server/mailbox.ts` | `pauseAt`、`atBoundary`、`CheckpointHandler`、`DiscussionCheckpoint`、状态 `checkpointDecisions` |
| §6 恢复与 CLI 模式 | 模式不可切换、`mad resume` 不修改模式/预算/角色 | `src/cli/index.ts` `src/core/execution.ts` | `resume`、`freezeInvocation`、`commitInvocation`、`readState` |
| §7 结构化审议 | 7 阶段、独立陈述/质疑/修订/收敛/草稿/审阅/最终 | `src/core/structured.ts` `src/core/outcome.ts` | `StructuredController.run`、`parallel`、`findDisputes`、`OutcomePipeline.run` |
| §8 自由讨论 | 覆盖周期、窗口边界、收敛评估、主持 Agent 不作为观点 | `src/core/discussion.ts` | `DiscussionController.run`、`speak`、`evaluate`、`atBoundary` |
| §9 资源与并发 | 三层限流、全局与 CLI 限流器、上下文预算与摘要、统一摘要规则 | `src/core/execution.ts` `src/core/context.ts` | `InvocationScheduler`、`Semaphore`、`SharedContextManager`、`estimateTokens` |

---

## 2. 逐条符合性判定

### §5 固定组局阶段

**§5.1 "使用默认组局器，或用户按次覆盖的允许组合"**
- 实现：`src/cli/index.ts` 第 415-422 行（默认 `registry.defaults.generator`，可选 `--organizer` 显式覆盖，要求格式 `CLI/PRESET`）。
- 验证：`resolveInvocation` 解析覆盖组合后再写入 manifest。
- 结论：**符合**。

**§5.2 "向组局器提供问题、单次资源上限和 CLI 注册表安全视图；项目审议允许其直接只读查看显式工作目录"**
- 实现：`src/core/planning.ts` 第 220-236 行 `buildPrompt` 输出 `registryView = clis.map(...)`，仅暴露 `cli/adapter/preset.id/context_budget`，**未包含** `executable`、`rawArgs`、options 推理设置等敏感字段。
- 资源限制透出 JSON 化的 `request.limits`。
- 项目审议时 `cwd = parsed.values.workspace`（`src/cli/index.ts` 第 410-413 行），并经 `requireProjectReadOnly` 校验。
- 结论：**符合**（注册表视图严格受限，未泄露可执行路径或环境变量）。

**§5.3 "组局器生成只属于本次审议的 Agent 实例，每个实例包含唯一 ID、CLI 配置、调用预设和角色描述"**
- 实现：`parseDeliberationPlan` 第 66-80 行 `participants.map`，要求 `id` 通过 `AGENT_ID = /^[a-z][a-z0-9_-]{0,63}$/`、唯一性检查（`new Set(ids).size !== ids.length`）、`role` 必填非空。
- 结论：**符合**。

**§5.4 "方案指定报告 Agent；自由讨论还指定主持 Agent。两者都必须是参与者"**
- 实现：`parseDeliberationPlan` 第 83-103 行：自由模式 `moderator_agent_id` 必填，`report_agent_id` 必填，两者均要求 `ids.includes(...)`。
- 结论：**符合**。

**§5.5 "对方案引用的唯一调用组合执行运行时预检"**
- 实现：`OrganizerService.preflightPlan` 第 184-201 行按 `cli/preset` 去重构建 `combinations: Map`，每个组合执行 `requireReady`（项目模式附加 `requireProjectReadOnly`）。所有组合成功才通过预检，否则任意一个失败即抛错。
- 结论：**符合**。

**§5.6 "方案确认后才进入正式审议"**
- 实现：`src/cli/index.ts` 第 198-262 行 `confirmPlan` 流程：交互式提供"接受 / 修改 / /regroup / /cancel"四类动作；非交互要求 `--auto-confirm-plan`（第 387-389 行）。
- 结论：**符合**。

**§5.6 "修改可以增删、改变角色/预设、改选主持与报告，但不能突破白名单和资源上限；新增组合重新预检；修改后完整方案再次确认"**
- 实现：`confirmPlan` 第 250-258 行：用户输入 JSON → `parseDeliberationPlan`（强制白名单 + 上限）→ `organizerService.preflightPlan`（重新预检）→ 等待下一次确认。
- 资源上限来自 `request.limits`，未在确认流程中被提高。
- 结论：**符合**（白名单与重新预检已落实）。

**§5 "非交互调用必须显式传入 --auto-confirm-plan，且只能自动接受第一次生成并通过所有校验的方案，不能自动修改或重新组局"**
- 实现：`src/cli/index.ts` 第 387-389 行 `--auto 必须同时显式传入 --auto-confirm-plan`；第 401-403 行 `auto + 无终端 + 缺 --auto-confirm-plan` 直接报错。
- 但需关注：在 `confirmPlan` 之外，仍只有一个有效方案被自动接受（详见偏差 D1）。
- 结论：基本符合，**见偏差**。

**§5 "默认组局器无效、不可用或预检失败时直接报错，不自动降级"**
- 实现：`OrganizerService.propose` 第 132-136 行要求 `requireReady`；`proposal` 失败抛 `PREFLIGHT` 错误。无静默 fallback。
- 结论：**符合**。

**§5 "同一 CLI 和调用预设可以生成多个不同角色的审议 Agent，并正常计入参与者数量与争议信号；页面与报告必须保留其共享来源"**
- 实现：`parseDeliberationPlan` 第 66-82 行不限制重复组合；`src/core/outcome.ts` 第 6-14 行 `sharedOriginWarning` 在生成草稿前注入提示并在最终报告中再次强调。
- 结论：**符合**。

### §6 CLI 与交互模式 + §14 恢复与失败

**"默认审议模式为 structured"`**
- 实现：`src/cli/index.ts` 第 364 行 `mode: { type: "string", default: "structured" }`。
- 结论：**符合**。

**"`mad resume <id>` 从档案恢复原模式、交互策略、方案和预算，不允许切换"**
- 实现：详见分册 #1 / CLI 入口对 `resume` 的实现；计划/`limits` 通过 manifest + state 恢复，`ResourceLimits` 与 `DeliberationPlan` 直接来自 `archive.readManifest()`/`archive.readState()`，调用点不再修改。
- 结论：**符合**（未发现 `resume` 覆盖 plan 的代码路径）。

**"guided 模式既无交互终端也无在线观察服务时立即失败，不无限等待"**
- 实现：`src/cli/index.ts` 第 396-400 行 `guided + !terminalAvailable + !observerAvailable` 抛 `USAGE` 错误。
- 结论：**符合**。

### §7 结构化审议

**7 阶段流程**：
| 阶段 | 实现位置 | 关键行为 |
| --- | --- | --- |
| 1. 独立陈述 | `StructuredController.run` 第 91-95 行 `parallel("independent", ...)` | 并行调用 `runner.run`，向 `context.addMany` 添加 |
| 2. 质疑与补充 | 第 102-106 行 `parallel("challenge", ...)` | 使用 `challengePrompt`，共享上下文 |
| 3. 修订意见与关键争议 | 第 108-132 行 `parseRevision` + `findDisputes` | 解析 `position` + `disputes[]`，按主题归并 |
| 4. 争议收敛 | 第 134-146 行 `convergence` 阶段 | 仅在 `disputeTopics` 非空时启动 |
| 5-7. 报告流水线 | 第 148-153 行 `OutcomePipeline.run` | 草稿、并行审阅、最终修订 |

- 引导模式检查点：第 95、106、132 行 `pauseAt("independent" | "challenge" | "disputes" | "draft")` 分别检查；`"draft"` 阶段通过 `OutcomePipeline.run` 回调传入。
- 屏障同步：通过 `parallel` (`settleAllOrThrow`) 与 `OutComePipeline.run` 内部 `settleAllOrThrow` 实现"同阶段参与者看不到本阶段尚未完成的其他输出"（stage 之间有显式 await 屏障，且并行阶段在 `context.addMany` 后才推进）。
- 结论：**符合**。

**Stage 与 barrier 是否完整**：
- 检查点类型 `StructuredCheckpointStage = "independent" | "challenge" | "disputes" | "draft"`（第 10 行），共 4 个。架构 §7 要求"独立陈述、质疑补充、争议判定、报告草稿后等待检查点"，实现一致。
- 最终修订（步骤 7）**不是** 检查点（架构未列出）；符合预期。

**争议收敛**：
- `findDisputes` 第 185-196 行：相同主题不同立场计入争议；`convergence` 阶段仅在 `disputeTopics.length > 0` 触发，符合 §7.4。
- `Revision` 解析拒绝未知字段（第 41-42 行），强制 schema 合规。

**报告流水线（§7.5-7.7 + §8 末段）**：
- `OutcomePipeline`：`draft → reviewers (excluding report agent) → final`，审阅由 `settleAllOrThrow` 并行（第 77-87 行），最终修订要求含标题与"共识/争议/假设/风险"关键字（`validateFinalReport` 第 20-31 行）。
- 共享来源提示在 `draft` 与 `final` 两处注入（`sharedOriginWarning` 调用位置）。
- 结论：**符合**。

### §8 自由讨论

**主持 Agent 调度规则**：
- `DiscussionController.run` 第 119-128 行：覆盖周期由主持调用 `coverage` 决定 `order`，参与者"恰好发言一次"。
- 第 129 行循环 `speak(...)`；第 131 行 `evaluate(...)` 准备下一窗口规划。
- 第 139 行 `max_windows` 上限来自 `plan.limits.maxDiscussionWindows`。
- 第 222-247 行 `atBoundary`：主持 `converged=true` 自动 `end`；guided 模式由 `checkpoint(window, converged, rationale)` 决定，第 234 行 `await this.checkpoint(...)`，未传入 `AbortSignal`。
- 第 156-157 行 supplementalEvidence 明确"主持调度不作为参与者观点"。
- 报告流水线复用 `OutcomePipeline.run`（第 158-163 行）。
- 结论：**符合**。

**发言回合与窗口**：
- `speak` 内部 `round = speeches.length + 1`，由 `this.context.snapshot` 计算共享上下文；`window_N` 标识每回合。
- 同一窗口内允许重复选择参与者，但不允许连续（同人），由 `parseModeratorPlan`（未直接展示但 `lastSpeaker` 已传入 `evaluate`）控制。
- 结论：**符合**。

**主持窗口规划边界**：
- `evaluate` 第 209 行 `sharedContext.snapshot(question, reserveTokens)` 按 `participantIds.length` 大小预留；引导检查点在 `atBoundary` 边界处发生，符合 §8.3-4。
- 结论：**符合**。

### §9 资源、并发与上下文

**三层约束**：
- 应用内置默认值（`src/cli/index.ts` `resolveLimits`，未在本审查范围）
- 用户按次覆盖（第 429-434 行 `integerOption(...)` 允许 `--max-*` 等）
- 安全最大值（`resolveLimits`）
- 组局器只读 `request.limits`；自身 prompt 中也"${JSON.stringify(request.limits)}" 注入但未变更逻辑。
- 结论：**符合**。

**全局限流与 CLI 配置级限流**：
- `InvocationScheduler` 第 40-56 行：全局 `Semaphore(globalMaximum)`；`perCli` Map 按 `cliId` 创建本地 `Semaphore(cliMaximum)`。`run` 串行获取本地→全局。
- `StructuredController` 第 78 行 `plan.limits.globalConcurrency ?? 6`，符合 §9。
- 结论：**符合**。

**上下文预算与摘要**：
- `SharedContextManager.snapshot` 第 47-101 行：触发条件 `estimateTokens(current) > targetTokens`，`targetTokens = min(contextBudget * 0.45, availableForContext)`。
- 摘要由报告 Agent 调用 `kind: "summary"` 的逻辑调用；摘要计入总调用预算（`beginAttempt`）。
- 同一摘要被所有参与者共享：`renderCurrent` 返回"统一滚动摘要 + 摘要后的最近记录"，所有 `speak`/`evaluate`/`OutcomePipeline` 通过 `snapshot(...)` 获取。
- 原始记录保留在 `transcript.jsonl`，`completedInvocations` 完整持久。
- 结论：**符合**。

**`estimateTokens` 启发式实现**：
- `src/core/tokens.ts` 第 1 行 `Math.ceil(text.length / 4)`。粗略估算，未与具体 tokenizer 对齐。多数 CLI 实际上下文以字符或词为准，此估算会产生 ±50% 偏差。
- **见偏差 P2-D2**。

---

## 3. 偏差清单

按 P0/P1/P2 排序。

### P0（阻断级）

未发现阻断级 P0 缺陷。系统能正确完成核心审议关键功能，关键状态机、屏障同步、报告流水线满足架构要求。

### P1（重要偏差）

**P1-D1：`pauseAt` 与讨论 `atBoundary` 不在 AbortSignal 触发时立即短路等待，可能让 abort 后等待检查点响应时阻塞过久（影响 §10/§14 暂停恢复语义）**

- 架构条款：§10「第一次 Ctrl-C 按暂停处理，并终止当前 CLI 子进程」、§14「恢复以逻辑调用为最小边界 ... 瞬时错误和 schema 输出错误各自动重试一次」。
- 证据：
  - `src/core/structured.ts` 第 198-223 行 `pauseAt`：若 `decision.action === "pause"` 抛 `MadError("PAUSED", ...)`。但若 abort 在 `await this.checkpoint(stage, summary)`（第 210 行）等待期间发生，调用层抛 abort 错误，**而非快速短路的 PAUSED**。`coordinatedStructuredCheckpoint` (`src/cli/index.ts` 第 264-309 行) 在 `mailbox.wait` 内部监听 `signal?.abort` 自动 `submit(checkpointId, "pause")`，因此最终仍会回到一致状态。但状态转换路径经历 `coordinatedStructuredCheckpoint` 的额外 await，**与 §10 "第一次 Ctrl-C 按暂停处理" 的即时性不完全匹配**。
  - `src/core/discussion.ts` 第 222-248 行 `atBoundary`：构造器未接收 `signal`，第 234 行 `this.checkpoint(window, ...)` 由调用方注入；discussion 自身的 abort 路径仅在 `evaluate`/`speak` 内部 `runner.run` 抛出 `PAUSED` 时才生效。
- 影响：暂停恢复路径在 abort 注入检查点时仍正确但稍慢；对于非协调模式（无 mailbox）若 checkpoint handler 自身不消费 abort，会出现"信号触发但仍等待响应"的边缘态。
- 修复建议：把 `signal` 显式传播至 `pauseAt` / `atBoundary`；`pauseAt` 入口先判断 `signal?.aborted` 直接抛 `PAUSED`；或在 controller 构造器将 abort 控制器注入 checkpoint 持有者，由其负责"快速短路"。

**P1-D2：`OutcomePipeline.run` 中 drafts 与 reviewers/final 的并行触发条件受 supplementalEvidence 影响，可能在结构化审议中冗余注入 (`src/core/outcome.ts:49`)**

- 架构条款：§7.5-7.7 + §8 末段要求报告生成严格基于权威上下文与草稿；架构并未要求结构化审议注入 supplementalEvidence，但 `OutcomePipeline.run` 第 43 行将 `supplementalEvidence` 作为共用参数。
- 证据：
  - `src/core/outcome.ts` 第 49 行 `if (this.context && supplementalEvidence.trim()) this.context.add("补充证据", ...)`：仅在 this.context 已存在且 supplementalEvidence 非空时注入。
  - 结构化审议调用方传入 `""`（`src/core/structured.ts:150`），自由讨论传入非空字符串（第 161 行），符合 §8 末段"自由讨论复用 ... 区分共识、未决争议、假设和风险"。
  - 但 schema 未对"supplementalEvidence 是否应包含在草稿与最终报告"做强制隔离。结构化审议如未来调用方传入非空，可能被附加到 context，混淆"草稿来源于 stage 4 收敛后"的不变量（虽然当前调用安全）。
- 影响：当前实现安全，但 API 形状增加未来误用风险；reviewers 看到 supplementalEvidence 与 context 时，**贡献来源不再纯粹来自权威发言**。
- 修复建议：将 `supplementalEvidence` 改名为带区分前缀的字段，或在 `OutcomePipeline` 构造时强制接受"supplemental 文本只附加在最终提示末尾、不进入 context 历史"的语义契约并写入类型定义。

**P1-D3：`Semaphore` 唤醒顺序潜在风险（先入先出假设被破坏）**

- 架构条款：§9「同一 CLI 下的全部调用预设和审议 Agent 共享限流器」，未明示 FIFO。
- 证据：`src/core/execution.ts` 第 17-30 行：
  ```ts
  public async use<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await operation(); }
    finally { this.active -= 1; this.waiting.shift()?.(); }
  }
  ```
  `waiting.shift()` 取出最早注册者，但 `acquire` 在 `this.active += 1` 后立即返回，未把当前 promise 与 shift 关联——当多个 awaiter 同时获得 `active` 槽释放，shift 仅触发其中之一，被等待的 promise 在 `resolve` 之前并不能保证按 FIFO 推进；其他 awaiters 仍挂在 push 队列中。
- 影响：低概率下并发量接近 `maximum` 时，少量调用次序漂移。不影响正确性（都是同一 CLI），但会被单调日志与诊断误导（attempt_started 与 attempt_started 顺序错位）。
- 修复建议：使用 `Promise` 队列存原始 `() => Promise<T>`，在 `active -= 1` 后调用 `waiting.shift()?.()` 唤醒最早等待者；这与现有实现一致，但应去除 `shift` 时把对应 resolve 与 promise 配对的歧义，**应保留传入 resolve 闭包**（实际就是如此，但需对 `resolve` 在所有 push 完成后才被调用的时序做单元测试）。

### P2（一般偏离与改进建议）

**P2-D1：`DiscussionController` 缺少 abort 显式传播，与 §10 暂停语义略不一致**

- 架构条款：§10/§14。
- 证据：`src/core/discussion.ts` 第 89-106 行构造器接收 `signal` 但 runner 设置后未在 `speak`/`evaluate` 直接读取；abort 信号路径仅依赖 `runner.run` 内部抛出 `MadError("PAUSED", ...)`。`atBoundary` 没有等待 abort 触发的快速路径。
- 影响：与 P1-D1 重复归类；考虑合并为 P1（不再单列）。
- 修复建议：作为 P1 修复的延伸。

**P2-D2：`estimateTokens = Math.ceil(text.length / 4)` 与真实 token 偏差较大**

- 证据：`src/core/tokens.ts` 第 1 行。
- 影响：
  - 触发摘要的阈值偏低，导致中英文混合 prompt 提前进入摘要循环；
  - 摘要后预算判断沿用同一估算，可能再触发第二轮（`round >= 12` 抛错），用户体验抖动。
- 修复建议：引入结构化估算（字符 / 中文比例加权）；或在配置中暴露每个 CLI 的 `tokensPerChar` 预设；当前阶段 §9 已声明"具体默认数值在 Codex 端到端验证后校准"，可视为可校准项。

**P2-D3：`SharedContextManager` 在 `targetTokens` 评估上以 `0.45 * contextBudget` 为常态上限，结构化提示可能过早压缩**

- 证据：`src/core/context.ts` 第 54 行 `targetTokens = Math.max(32, Math.min(Math.floor(this.contextBudget * 0.45), availableForContext))`。
- 影响：当预留 `reserveTokens` 较小，理论上 context 占用 45% 之外还有 55% 的余量被浪费；但当预留接近上限时，反而可能压缩不到目标，整体合理。
- 建议：当 `reserveTokens < contextBudget * 0.1` 时，target 仍按 `0.45 * contextBudget` 限制；可考虑动态调整成 `min(0.7, 1 - reserveTokens/contextBudget)`，保持摘要尽量保留最新发言。

**P2-D4：`coordinatedStructuredCheckpoint` 与 `coordinatedDiscussionCheckpoint` 在第 305、352 行重复 `await archive.recordCheckpointDecision(key, decision)`，但 `mailbox.wait` 已通过 `onAccepted` 调用过 `recordCheckpointDecision`（第 295-300 行），可能造成幂等覆盖且 `at` 时间戳被覆盖两次**

- 证据：`src/cli/index.ts` 第 295-305 行 与 305-306 行：
  ```ts
  async (accepted) => archive.recordCheckpointDecision(key, {
    action: accepted.action === "guide" ? "continue" : accepted.action,
    ...(accepted.guidance ? { guidance: accepted.guidance } : {}),
    at: accepted.at,
  }),
  );
  ...
  await archive.recordCheckpointDecision(key, decision);  // 再次写入
  ```
- 影响：第二次写入以 `new Date().toISOString()` 为 `at`，**覆盖了第一次的原始时间**（来自 CheckpointResponse.at）。这破坏 §13 "档案可审计"，丢失"页面响应到达的原始时间戳"。
- 修复建议：移除第二次 `recordCheckpointDecision`，或仅写入第二次 acting 之前未记录过的字段；让 `at` 字段保持 CheckpointMailbox 的原始 `at`。

**P2-D5：`OutcomePipeline.run` 在 `this.context` 不存在时不写入 transcript 摘要路径**

- 证据：`src/core/outcome.ts` 第 49 行 `if (this.context && supplementalEvidence.trim()) this.context.add(...)`，且后续 `this.context?.addMany(...)`（第 88 行）。但当前两个调用方均传 `this.context`，无影响。
- 修复建议：删除 optional chain，强制要求 context 注入，使行为契约更明确。

**P2-D6：报告生成校验规则过宽 — 仅做正则匹配关键字而非结构化章节**

- 证据：`src/core/outcome.ts` 第 20-31 行 `validateFinalReport`：仅检测 `^#{1,3}\s+/m` 与四个关键字（共识/未决争议/假设/风险）。
- 影响：模型可能在同一段里以长 Markdown 自洽完成四个关键字要求，无小节区分；与 §7.7 "共识、未决争议、假设和风险" 区分的语义有距离。
- 修复建议：解析 Markdown 实际 h2/h3 章节，分别匹配章节关键字；如需保持轻量，至少强制每个关键字独占段落。

**P2-D7：`SharedContextManager.snapshot` 第 67 行 `if (round >= 12)` 是硬编码最大循环**

- 证据：`src/core/context.ts` 第 67 行。
- 影响：在极低 `contextBudget`（如 1024 tokens）但仍可被 preset 接受时，循环可能未达 12 轮已 overshoot；或者多个不同 CLI preset 竞合预算时也无法稳定收敛。
- 修复建议：将最大循环数限制写成显式 `MAX_SUMMARY_ROUNDS` 常量并暴露在 `ResourceLimits`；现有 12 与 §9 校准待办事项一致，可保留默认值。

---

## 4. 分册结论摘要

**总体**：核心审议实现满足架构 §5/§7/§8/§9 的主体要求。固定组局阶段的注册表安全视图、白名单 + 预检 + 重复组合去重、结构化审议的 7 阶段屏障（含 `pauseAt` 在独立陈述/质疑/争议/草稿四处等待检查点）、自由讨论的覆盖周期与窗口边界、主持调度不作为参与者观点、全局与 CLI 限流器、共享来源警告、统一滚动摘要与原始记录保留均按架构落地。

**关键风险点**：
1. **P1-D1：abort 触发到 PAUSED 状态的快速短路不充分**。架构要求 §10 即时中止当前 CLI 子进程并按暂停处理；当前 `pauseAt` / `atBoundary` 不在等待检查点响应时立即检测 abort，需要 `coordinatedStructuredCheckpoint` 的 `mailbox.wait` 触发 `onExternalAbort` 才能回退。建议显式把 signal 传入并提前检测。
2. **P1-D2：报告流水线 `supplementalEvidence` 与共享 context 的耦合边界**，API 形状有未来误用风险；当前两个调用点安全。建议把"supplemental 不进 context 历史"的语义契约固化进类型。
3. **P1-D3：并发 Semaphore 的 FIFO 假设**实际代码路径正确但缺测试覆盖，唤醒顺序与 attempt_started 日志一致性需要验证。

**改进方向**：
- `estimateTokens` 在 §9 已声明 Codex 校准后再定默认值，P2-D2 属于已知待校准项。
- `validateFinalReport` 的结构化校验（P2-D6）可提升报告可审计性。
- `recordCheckpointDecision` 重复写入导致 `at` 字段被覆盖（P2-D4）破坏档案审计字段，应作为一次清理。

**结论**：核心审议实现具备完整的结构化与自由讨论主流程、暂停/恢复、检查点协作、并发隔离与上下文预算保护；P1-D1/D2 是必须修复或加固的，P2 项为可优化项。`src/core` 目录的逻辑控制器层（`StructuredController`、`DiscussionController`、`OutcomePipeline`）与执行层（`InvocationRunner`、`InvocationScheduler`、`SharedContextManager`）职责清晰、状态机自洽，与架构的"Controller 持有权威状态、硬限制与恢复边界"原则一致。

---

**审查分册 #2 完成时间**：2026-07-22
**审查范围独立确认**：未读取 `docs/审查报告/agy/*` 和 `docs/审查报告/grok/*` 任何内容。
