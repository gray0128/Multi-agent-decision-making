# 核心审议实现审查（对照 TypeScript 目标架构 §5 / §7 / §8 / §9）

## 1. 审查范围与方法

**对照基准**：`docs/TypeScript目标架构.md` 第 5、7、8、9 节（固定组局、结构化审议、自由讨论、资源/并发/上下文）。不引用其他审查报告或验收结论。

**审查对象（源码 + 相关测试）**：

| 模块 | 路径 |
|------|------|
| 组局 | `src/core/planning.ts`、`src/cli/index.ts`（`confirmPlan` / `deliberate` / `resume`） |
| 结构化 | `src/core/structured.ts`、`src/core/outcome.ts` |
| 自由讨论 | `src/core/discussion.ts` |
| 资源/并发/上下文 | `src/core/limits.ts`、`src/core/execution.ts`、`src/core/context.ts`、`src/core/tokens.ts` |
| 类型与错误 | `src/core/types.ts`、`src/core/errors.ts` |
| 页面共享来源 | `src/web/index.ts` |
| 测试 | `tests-ts/planning.test.ts`、`structured.test.ts`、`discussion.test.ts`、`limits.test.ts`、`context-manager.test.ts`、`execution.test.ts` |

**方法**：以架构条文为检查表，对实现做逐条源码对照（含 codegraph 符号探查），用路径:行号固定证据；仅当行为与条文冲突时记为偏差。

---

## 2. 符合项（路径:行号）

### 2.1 第 5 节 固定组局阶段

| 架构要求 | 证据 |
|----------|------|
| 默认组局器或按次覆盖 | 默认取 `registry.defaults.generator`（`src/cli/index.ts:415-416`）；`--organizer CLI/PRESET` 覆盖并 `resolveInvocation`（`417-421`） |
| 向组局器提供问题、资源上限、CLI 安全视图 | `OrganizerService.buildPrompt` 注入问题、`JSON.stringify(request.limits)`、仅含 `cli/adapter/presets{id,context_budget}` 的注册表视图（`src/core/planning.ts:220-235`） |
| 项目审议允许只读工作目录 | `projectMode` 时 `requireProjectReadOnly` + 预检（`planning.ts:135-136,197,209-217`）；CLI 将 `--workspace` 设为 `cwd` 与 `workspace.mode: direct-read-only`（`cli/index.ts:409-413,457,490`） |
| 方案含唯一 ID、CLI、preset、角色 | `parseDeliberationPlan` 校验 `id/cli/preset/role`、ID 正则与唯一性（`planning.ts:66-82`）；类型 `DeliberationAgent`（`types.ts:23-27`） |
| 指定报告 Agent；自由讨论指定主持；须为参与者 | `report_agent_id` 必须在 ids 内（`planning.ts:83-84`）；free 模式强制 `moderator_agent_id` 且为参与者（`92-94`）；≥3 时优先分离的软提示（`230`） |
| 唯一调用组合运行时预检 | `preflightPlan` 以 `cli/preset` 去重后 `check`（`planning.ts:184-200`）；测试确认同组合只检一次（`tests-ts/planning.test.ts:60-81`） |
| 交互确认：确认 / 修改 / 附带指导重新组局 / 取消 | `confirmPlan` 提示与分支（`cli/index.ts:222-248`）：空回车确认、完整 JSON 修改、`/regroup`、`/cancel` |
| 修改不突破白名单与资源上限；新增组合再预检；改后再次确认 | 修改走 `parseDeliberationPlan`（注册表 resolve + `maxParticipants`，`planning.ts:63-74`）+ `preflightPlan`（`cli/index.ts:250-257`）；循环回显方案再次确认（`218-219`） |
| 非交互须 `--auto-confirm-plan`；只接受首次通过校验方案；不自动改方案 | `--auto` 强制同时带 `--auto-confirm-plan`（`cli/index.ts:387-388`）；有 flag 时直接 `proposed.plan`（`496-508`）；`planConfirmation: auto-first-valid`（`513`）；无 runner 路径 `allowRegeneration === false` 仅 1 次（`planning.ts:158`） |
| 默认组局失败不降级 | 预检失败抛 `PREFLIGHT`（`planning.ts:203-206`）；无备用组局器切换 |
| 同 CLI+preset 多角色计入参与者；共享来源不得当独立交叉验证 | 解析允许多实例同 invocation（`planning.ts:229`）；`sharedOriginWarning`（`outcome.ts:6-13`）；草稿/终稿 prompt 注入（`51,91`）；CLI 警告（`cli/index.ts:516-519`）；页面展示 `cli/preset`（`web/index.ts:25`） |

### 2.2 第 7 节 结构化审议

| 架构要求 | 证据 |
|----------|------|
| 阶段顺序：独立陈述 → 质疑补充 → 修订与争议信号 → 可选一次争议收敛 → 草稿 → 并行审阅 → 最终修订 | `StructuredController.run`（`structured.ts:91-153`）：`independent` → `challenge` → `revision`+`findDisputes` → 有争议才 `convergence` → `OutcomePipeline`（草稿/审阅/终稿，`outcome.ts:57-103`） |
| 逻辑并行 + 全局限流 + CLI 级限流 | `parallel`/`settleAllOrThrow`（`structured.ts:165-182`）；`InvocationScheduler` 全局+per-cli 信号量（`execution.ts:40-55,144`）；默认 CLI 并发 1（模板 `adapters/config.ts:228`，`max_concurrency` 缺省 fallback 1：`152`） |
| 同阶段看不到未完成输出 | 各阶段在并行前一次性 `context.snapshot`，结果在 `settleAllOrThrow` 之后才 `addMany`（如 `structured.ts:100-105,112-130`）；独立陈述不注入他方输出（`91-93`） |
| guided 在独立陈述、质疑补充、争议判定、报告草稿后检查点 | `pauseAt("independent"|"challenge"|"disputes"|"draft")`（`structured.ts:95-96,106,132,152`）；`StructuredCheckpointStage` 仅此四类（`10`）；CLI `coordinatedStructuredCheckpoint`（`cli/index.ts:264-308`） |

### 2.3 第 8 节 自由讨论

| 架构要求 | 证据 |
|----------|------|
| `DiscussionController` 持有权威状态；主持一次性 CLI 规划 | 类与构造（`discussion.ts:84-106`）；覆盖周期 `discussion:moderator:coverage`（`119-128`）；窗口规划 `discussion:moderator:window:${window}`（`210-218`） |
| 主持计入总调用，不算发言回合/参与者观点 | `kind: "moderator"` 走 `beginAttempt` 计次（`execution.ts:134`）；发言仅 `speak` 写入 `speeches`/`context`（`discussion.ts:179-195`）；主持输出不入 `SharedContextManager`；报告补充说明（`156-157`） |
| 覆盖周期每位恰一次 → 开放讨论不可连续同一人 → 每 N 发言结束检查窗口 | `parseCoverage` 恰一次全覆盖（`48-56`）；`parseModeratorPlan` 禁止连续且未收敛时 `speakers.length === N`（`59-77`）；覆盖后与每窗后 `evaluate` + `atBoundary`（`129-148,222-247`） |
| 窗口边界收敛评估；guided 可继续/指导/结束/暂停/取消 | `evaluate` 产出 `converged/rationale/speakers`（`197-219`）；`coordinatedDiscussionCheckpoint` 动作集（`cli/index.ts:321-333`） |
| 结束后复用报告流水线 | `OutcomePipeline.run`（`discussion.ts:158-162`）；草稿→并行审阅→终稿（`outcome.ts:57-103`）；区分共识/争议/假设/风险（`validateFinalReport`，`20-31`） |

### 2.4 第 9 节 资源、并发与上下文

| 架构要求 | 证据 |
|----------|------|
| 三层约束：内置默认 / 按次覆盖 / 安全最大 | `DEFAULT_LIMITS`、`SAFE_MAX_LIMITS`、`resolveLimits`（`limits.ts:4-30`）；CLI 选项合并（`cli/index.ts:429-442`） |
| 组局器可见但不能提高限制 | prompt 含 limits（`planning.ts:232`）；解析强制 `maxParticipants ≤ options.limits`（`63-64`）；方案 JSON 不允许写入自定义 limits 字段（`keysOnly`，`57-60`） |
| 全局限流 + CLI 级限流；CLI 默认并发 1 | 见 §2.2；`init` 模板 `max_concurrency = 1`（`adapters/config.ts:228`） |
| 预算写入档案，恢复不改变 | `manifest.plan.limits` / `planning.limits` 落档（`cli/index.ts:452-469,509-514`）；`resume` 使用档案 plan/planning，无覆盖参数（`558-563,600-640`）；`registrySnapshot` 固化 `maxConcurrency`（`142-160`） |
| 上下文不足时报告 Agent 统一滚动摘要；全员同一摘要 | `SharedContextManager.snapshot` 由 `reportAgentId` 生成 summary（`context.ts:47-100`）；`renderCurrent` = 统一摘要 + 摘要后最近记录（`103-108`）；并行阶段共用同一 snapshot 字符串；摘要 `kind: "summary"` 计入调用且逻辑 ID 可恢复（`80-93`）；测试（`tests-ts/context-manager.test.ts:13-65`） |
| 调用前估算输入 | `InvocationRunner.run` 用 `estimateTokens(call.prompt)` 对照预算（`execution.ts:106-112`） |

---

## 3. 偏差缺口（按严重度）

### 3.1 中 — 非交互组局在 runner 路径仍可因 schema 失败静默重试，弱化「仅接受第一次通过校验的方案」

**架构**：非交互必须 `--auto-confirm-plan`，且只能自动接受**第一次生成并通过所有校验**的方案，不能自动修改或重新组局。

**证据**：

1. CLI 组局始终注入 `InvocationRunner`（`src/cli/index.ts:475-481`），走 `OrganizerService.propose` 的 runner 分支（`planning.ts:139-155`）。
2. 该分支**不读取** `allowRegeneration`；仅无 runner 时才用 `allowRegeneration === false → maximumAttempts = 1`（`planning.ts:157-158`）。
3. `InvocationRunner` 对 `parse` 失败抛 `RetryableMadError` 并在同一逻辑调用上最多尝试 2 次（`execution.ts:131-161,202-205`），第二次成功即可提交——内容已是第二次模型生成。
4. auto 模式虽写 `allowRegeneration: false`（`cli/index.ts:456,489`），对上述 runner 重试**无约束**。

**影响**：机器调用在组局 JSON 非法时可能悄悄接受第二轮输出，与条文「第一次…通过校验」字面含义不一致；预检失败仍会直接报错（符合「不降级」），缺口集中在 schema 软失败重试。

**建议**：当 `allowRegeneration === false` 或 `planConfirmation === auto-first-valid` 时，organizer 的 `parse` 失败改为不可重试错误；或 runner 支持 per-call `maxAttempts: 1`。

### 3.2 低 — 交互式 JSON 修改校验失败时退出确认循环，而非回显错误后再次确认

**架构**：修改后完整方案再次确认；交互应能继续调整。

**证据**：`confirmPlan` 在 JSON 修改路径直接 `parseDeliberationPlan` + `preflightPlan`（`cli/index.ts:250-257`），异常无 catch，会离开 `while` 循环并结束确认。`/regroup` 成功路径才 `continue`（`232-248`）。

**影响**：用户粘贴非法 JSON 或越权字段时整次审议失败，而不是「提示错误 → 仍显示当前方案 → 可再改」。

**建议**：修改/预检失败时写 stderr 错误并 `continue`，仅 `/cancel` 或信号中止才退出。

### 3.3 低 — 项目审议组局 prompt 未显式声明可只读查看的工作目录

**架构**：项目审议还允许组局器直接只读查看显式工作目录。

**证据**：能力侧已做 `projectReadOnly` 验证并以 workspace 为 `cwd`（见符合项）。但 `buildPrompt`（`planning.ts:220-235`）未写入工作目录绝对路径，也未提示「项目模式、可只读浏览 cwd」。依赖底层 CLI 自行发现 cwd，行为因适配器而异。

**影响**：组局器可能未实际利用工作目录，项目审议角色配置质量下降；非安全越权问题。

**建议**：`projectMode` 时在 prompt 中写明 workspace 路径与只读约束说明。

---

## 4. 风险建议

| 优先级 | 建议 |
|--------|------|
| P1 | 对齐 auto 组局「单次生成」语义：关闭 runner 对 organizer/parse 的二次尝试，或让 `allowRegeneration` 贯通 runner 路径 |
| P2 | `confirmPlan` 对修改/预检失败容错回环，避免误伤交互用户 |
| P3 | 项目模式组局 prompt 显式 cwd；可选在观察页对重复 `cli/preset` 聚合提示（报告侧已有 `sharedOriginWarning`） |
| 观测 | `findDisputes` 依赖 topic/stance 字面归一（`structured.ts:185-195`），漏检时会跳过收敛轮——属策略细节，非架构硬违例，可后续增强 |

**已做得好的防护（保持）**：

- 方案字段白名单与注册表 resolve，防止模型注入可执行路径/模型名。
- 并行阶段屏障 + 共享上下文单快照，满足同阶段隔离。
- 主持 `kind` 与发言上下文分离，报告流水线强制四段结构。
- 三层 limits + 档案冻结 + resume 只读恢复路径清晰。

---

## 5. 小结评分

| 维度 | 符合度 | 说明 |
|------|--------|------|
| §5 固定组局 | 高 | 默认/覆盖、安全视图、预检、交互四动作、auto-confirm 主路径完整；runner 下 auto 重试为主要缺口 |
| §7 结构化审议 | 高 | 七段流水线、屏障并行、四级 guided 检查点与限流均落地 |
| §8 自由讨论 | 高 | Controller 权威、覆盖/开放/窗口/主持一次规划、复用 OutcomePipeline |
| §9 资源并发上下文 | 高 | 三层 limits、双层限流、统一滚动摘要与预算落档恢复一致 |

**综合评分：88 / 100**

**偏差统计**：共 **3** 项（中 **1**、低 **2**）；**最高严重度：中**。

**一句话结论**：核心审议链路与目标架构 §5/7/8/9 高度对齐，可审计与限流设计扎实；唯一需要优先收紧的是非交互组局在 `InvocationRunner` 路径上对非法 schema 的二次生成重试。

---

## 变更记录

- **2026-07-22**：初稿。独立对照 `TypeScript目标架构.md` §5/7/8/9 审查 `src/core/*` 与 `src/cli/index.ts` 组局确认路径；记录 1 中 + 2 低偏差，综合 88 分。
