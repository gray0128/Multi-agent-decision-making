# Multi-Agent Decision Making - 归档与恢复机制合规性审查报告

本审查报告由 `agy_archive_recovery_reviewer` 独立撰写，旨在针对 `docs/TypeScript目标架构.md` 第 13 节（透明档案）与第 14 节（恢复与失败）的要求，对当前 TypeScript 实现进行严格的合规性审查。

---

## 1. 审查范围与方法

### 审查范围
* **源文件**：
  * [src/archive/store.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/store.ts) — 档案持久化与全局锁
  * [src/archive/schema.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/schema.ts) — 档案与状态的结构验证
  * [src/archive/redact.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/redact.ts) — 诊断数据脱敏
  * [src/core/execution.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts) — 逻辑调用生命周期、去重、重试与调度
  * [src/core/structured.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts) — 结构化审议流程与检查点恢复
  * [src/core/discussion.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts) — 自由讨论回合控制与恢复
  * [src/cli/index.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts) — 审议启动、恢复命令接口与状态映射
  * [src/server/observer.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts) — 观察服务 API 与 SSE 实时事件流
* **测试文件**：
  * [tests-ts/archive.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/archive.test.ts)
  * [tests-ts/cli-e2e.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/cli-e2e.test.ts)
  * [tests-ts/structured.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/structured.test.ts)
  * [tests-ts/discussion.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/discussion.test.ts)

### 审查方法
* **静态代码分析**：逐行走走读核心逻辑，建立实现细节到架构规范的严格映射。
* **行为与测试验证**：运行全量 TypeScript 测试，重点验证重跑去重、全局锁竞争抢占、敏感信息脱敏和中断恢复的测试用例。

---

## 2. 合规项清单 (Conforming Items)

### 2.1 透明档案文件结构 (§13)
实现完全符合架构规定的独立审议归档目录结构：
* **`manifest.json`**：存储审议 ID、创建时间、问题、模式、交互策略、参与者配置（方案）及 schema 版本。由 [schema.ts:L123-177](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/schema.ts#L123-177) 严格校验，由 [store.ts:L198-202](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/store.ts#L198-202) 写入并持久化 `schema_version: 1`。
* **`state.json`**：保存可恢复的状态，包括运行状态、更新时间、总模型调用次数、用户指导信息、待处理和已完成的逻辑调用等。由 [store.ts:L39-44](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/store.ts#L39-44) 的 `atomicJson` 函数（写临时文件后原子 `rename` 覆盖并加锁 `0o600`）实现**原子替换**。
* **`events.jsonl`**：只追加生命周期事件。通过 [store.ts:L237-245](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/store.ts#L237-245) 的 `appendEvent` 追加。
* **`transcript.jsonl`**：只追加权威发言记录。通过 [store.ts:L204-215](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/store.ts#L204-215) 的 `ensureTranscript` 幂等追加（检查 `logicalCallId`，防止重复）。
* **`diagnostics.jsonl`**：只追加脱敏后的调用诊断。通过 [store.ts:L217-223](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/store.ts#L217-223) 调用 `redactDiagnostic` 并只追加写入。
* **`report.md`**：最终共同成果 Markdown 报告。由 [store.ts:L247-253](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/store.ts#L247-253) 原子写入。

### 2.2 观察服务无数据库依赖 (§13)
* 观察服务 [src/server/observer.ts:L71-99](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts#L71-99) 在查询历史和实时视图时，全部使用 `ArchiveStore` 与 Node.js 文件系统操作（`readdir`/`readFile`）直接读取原始 JSON/JSONL/MD 归档文件，未使用任何数据库，完全符合规范。

### 2.3 逻辑调用边界与去重机制 (§14)
实现以逻辑调用为最小粒度的流程控制：
* **冻结输入**：在调用 CLI/API 之前，[execution.ts:L122](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L122) 持久化冻结当前逻辑调用的输入 (`archive.freezeInvocation`)。
* **幂等去重**：每次执行前先检查是否已存在于 `completedInvocations` 中 ([execution.ts:L124-128](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L124-128))。若已完成，直接返回已提交结果，绝不重复调用。
* **原子提交**：当适配器返回结果且通过结构校验后，调用 `commitInvocation` 原子写入 `state.json`，并确保权威发言记录只向 `transcript.jsonl` 提交一次 ([execution.ts:L168-181](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L168-181))。若在 CLI 完成但尚未提交时崩溃，下一次恢复虽然会产生重试/重复计费风险，但权威记录只能原子提交一次 ([execution.ts:L183-191](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L183-191))。

### 2.4 并行阶段恢复与自由讨论回合恢复 (§14)
* **结构化并行阶段恢复**：[StructuredController.ts:L91-183](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts#L91-183) 使用并行包装器调度各个参与者。每个参与者的调用 ID 均带有唯一的阶段与名称（如 `structured:independent:Claude`）。恢复时，已完成的参与者保留结果，仅未完成或失败的参与者会通过 `InvocationRunner` 重跑。
* **自由讨论逐回合恢复**：[DiscussionController.ts:L179-195](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L179-195) 中，每个回合发言均使用包含回合数与参与者 ID 的唯一逻辑 ID（如 `discussion:speech:window_1:4:Claude`）进行持久化。中断后恢复时，完全基于已有的回合记录向后推进，实现逐回合恢复。

### 2.5 瞬时错误与 Schema 错误重试政策 (§14)
* **重试策略**：[execution.ts:L131](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L131) 实现了固定 `for (let retry = 0; retry < 2; retry += 1)` 循环（即 1 次初始尝试 + 1 次重试）。
* **错误分类**：
  * **瞬时错误**：利用 `isLikelyTransientFailure` 正则匹配超时、限流、连接重置、过载等异常，抛出 `RetryableMadError` ([errors.ts:L23-25](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/errors.ts#L23-25))。
  * **Schema 校验错误**：如果在逻辑调用输出解析时抛出异常，会被捕获并重新包装为 `RetryableMadError` 抛出 ([execution.ts:L156-160](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L156-160))。
  * **非重试错误**：对于普通的 `MadError`（例如配置错误 `CONFIG` 或预检失败 `PREFLIGHT`），不进行重试，直接抛出中断 ([execution.ts:L201-202](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L201-202))。
* **暂停逻辑**：二次重试失败后，抛出 `MadError("EXECUTION")`，控制器将其捕获并使审议状态更新为 `paused`，转入可恢复状态 ([structured.ts:L158-161](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts#L158-161); [discussion.ts:L167-175](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L167-175))。

### 2.6 恢复约束 (§14)
* 代码在恢复时没有执行任何重组局、降低最少人数限制、替换适配器或预设的操作。
* 恢复流程 ([cli/index.ts:L578-600](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L578-600)) 直接使用原档案中的 `manifest.json` 加载注册表快照、参与者配置与规划阶段设置，保持输入及策略的绝对一致性。

### 2.7 脱敏与关联诊断 (§14)
* 每次尝试均通过 `randomUUID()` 分配唯一的 `attemptId`，并在脱敏后的诊断日志中将其与 `logicalCallId` 关联 ([execution.ts:L135-142](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L135-142), [L169-177](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L169-177))。
* 敏感词过滤 ([redact.ts:L1-17](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/redact.ts#L1-17)) 精准清除了 Bearer 令牌、环境变量机密、API 密钥以及密码等敏感信息。

### 2.8 原子全局锁限制 (§14)
* `ActiveDeliberationLock` 锁目录在 `${paths.runtime}/active.lock` 下。在 `mad deliberate` 和 `mad resume` 命令执行任何核心流程前，必须成功获取该锁 ([cli/index.ts:L444](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L444), [L573](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L573))。
* 提供了锁的回收机制 `reclaimStale` ([store.ts:L306-337](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/store.ts#L306-337))，如果持有锁的 PID 已经停止（检测 `process.kill(pid, 0)` 失败），能够安全回收锁，防止死锁。

---

## 3. 偏差/缺陷与建议 (Deviations/Issues & Recommendations)

* **偏差/缺陷**：无。
* **建议**：
  * 在 `ActiveDeliberationLock.reclaimStale` 逻辑中，如果 `active.lock` 存在但内容为空或损坏（引发 `JSON.parse` 错误），当前的 `reclaimStale` 会进入 `catch` 分支并返回 `false`，这会导致锁无法被自动回收，必须人工删除。建议在解析失败且捕获异常时，检查锁文件修改时间，若超过一定阈值则视为损坏并允许强制 `unlink`。

---

## 4. 结论与评分 (Summary & Rating)

TypeScript 版本的透明归档和恢复机制设计精良，表现出极高的健壮性。特别是：
1. **纯文件驱动的去重控制**：确保了对模型调用的严格控制，不依赖外部数据库，保障了去重的绝对稳定性。
2. **逻辑调用生命周期 (freeze -> attempt -> invoke -> commit) 机制完整闭环**：对瞬时异常与 Schema 异常的自动单次重试逻辑精确执行，故障时能优雅暂停并转换到 `paused` 状态。
3. **全局锁控制完备**：保障了单实例并发的安全，且提供了针对失效进程的锁回收能力。

### 综合评分：⭐⭐⭐⭐⭐ (5/5, 完全合规)
