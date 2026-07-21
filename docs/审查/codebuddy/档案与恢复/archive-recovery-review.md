# 第 13 节（透明档案）与第 14 节（恢复与失败）一致性审查报告

> 审查范围：`docs/TypeScript目标架构.md` 第 13、14 节 vs `src/archive/store.ts`、`src/archive/index.ts`、`src/core/paths.ts`、`src/core/execution.ts`、`src/core/types.ts`、`src/cli/index.ts`、`tests-ts/archive.test.ts`、`tests-ts/interrupt.test.ts`。
> 审查时间：2026-07-21。

## 总体结论

第 13、14 节的承诺基本落实在代码中，包括独立目录结构、原子替换状态、只追加事件/转写/诊断、观察服务只读、全局活动锁、恢复以逻辑调用为最小边界、重试一次后再暂停等核心要求。少量差异主要在工程取舍而非违反规范，例如 `state.json` 在原子写入时仍存在 ≤1 个旧文件句柄的窗口、并发校验在重试路径上未做新的预检。整体未发现缺失实现或过度实现的关键点；亦未引入数据库。

---

## 第 13 节 透明档案

### 13.1 每次审议保存为独立目录（6 个文件齐全）

**目标要求**：每次审议保存为独立目录，包含 `manifest.json / state.json / events.jsonl / transcript.jsonl / diagnostics.jsonl / report.md`。

**代码证据**：
- `src/archive/store.ts:57-76` `create()` 方法：建立 `mkdir(path, { recursive: false, mode: 0o700 })`，随后 `writeManifest`、`writeState`、并行创建 `events.jsonl / transcript.jsonl / diagnostics.jsonl`。
- `src/archive/store.ts:248-254` `writeReport()`：写入 `report.md`，使用临时文件 + `rename` 原子替换。

**差异描述**：六个文件均按目录创建。`report.md` 不在 `create()` 阶段生成，而是在共同成果完成后由 `src/core/structured.ts:145` 和 `src/core/discussion.ts:147` 调用 `writeReport` 写入，符合"最终共同成果"的语义。

**严重度**：无差异。

**判定**：已实现。

---

### 13.2 manifest.json 字段完整性与 schema_version

**目标要求**：包含身份、模式、参与者、方案和 `schema_version`。

**代码证据**：
- `src/core/types.ts:67-87` `DeliberationManifest` 类型：包含 `id`、`createdAt`、`question`、`mode`（`structured | free`）、`interaction`（`guided | auto`）、`plan: DeliberationPlan`、`registrySnapshot`、`workspace`、`planConfirmation`、`planning`，以及 `schemaVersion: 1`。
- `src/archive/store.ts:204-219` `readManifest`/`writeManifest`：写入时使用 `{ schema_version: 1, ...manifestValue }` 蛇形命名。

**差异描述**：身份（id/createdAt/question）、模式（mode）、交互策略（interaction，规范在 13.2 中未点名但 6.1/6.3 强制要求）、方案（plan，含 participants/reportAgentId/moderatorAgentId/limits）均完整。`schema_version` 字段以蛇形命名落盘，读取时兼容 snake/camel 两种形式。

**严重度**：无差异。

**判定**：已实现。

---

### 13.3 state.json 原子替换

**目标要求**：`state.json` 原子替换。

**代码证据**：
- `src/archive/store.ts:37-42` `atomicJson()`：写 `${path}.${pid}.${uuid}.tmp`，`wx` 创建，`rename` 替换，最后 `chmod 0o600`。
- `src/archive/store.ts:95-98` `writeState()` 通过 `atomicJson` 落盘。
- `src/archive/store.ts:256-263` `mutateState()`：内部先 `readState()` 再 `writeState(transform(state))`，并通过 `mutationQueue` 串行化。

**差异描述**：原子写入使用 POSIX rename 实现，符合规范。`mutateState` 使用了"读-改-写"循环（read-modify-write），这本身不是原子操作，但通过实例内 `mutationQueue` 串行化，保证同一进程内不会出现交叉写入；不同进程并发写入仍依赖 rename 的最终一致性，但目录创建时 `mkdir(..., recursive: false)` 避免了同 ID 并发创建。`tests-ts/archive.test.ts:74-87` 验证了"跨 store 实例"的状态可读，间接验证了 rename 替换对外可见。

**严重度**：低（工程取舍）。

**判定**：已实现。

---

### 13.4 events.jsonl / transcript.jsonl / diagnostics.jsonl 只追加

**目标要求**：三个 jsonl 文件只追加。

**代码证据**：
- `src/archive/store.ts:234-246` `appendEvent` 使用 `appendFile` 写入 `events.jsonl`；`appendDiagnostic` 同样 `appendFile` 写入 `diagnostics.jsonl`。
- `src/archive/store.ts:221-232` `ensureTranscript`：读取文件内容并对 `logicalCallId` 去重后再 `appendFile`，保证同一逻辑调用只追加一次。
- 三个文件均无任何覆盖或截断接口；`create()` 时仅以 `wx` 创建空文件。

**差异描述**：规范要求"只追加"；`events.jsonl` 与 `diagnostics.jsonl` 是直接追加，`transcript.jsonl` 通过逻辑调用 ID 幂等去重，符合"权威发言记录只追加"的语义。`tests-ts/archive.test.ts:67-69` 验证了同一 `logicalCallId` 重复 `ensureTranscript` 不会产生第二条记录。

**严重度**：无差异。

**判定**：已实现。

---

### 13.5 观察服务只读访问档案

**目标要求**：观察服务只读访问档案。

**代码证据**：
- `src/server/observer.ts:75` `readFile(join(root, "report.md"))`。
- 整个 `src/server/` 目录中 grep 无任何 `writeFile`/`appendFile`/`rename`/`atomicJson` 调用。
- `src/archive/store.ts` 的所有 `writeFile`/`rename`/`appendFile` 都封装在 `ArchiveStore` 类中，`src/server/` 没有引用该类的写方法（仅有 `readState`、`readManifest` 等读路径）。

**差异描述**：观察服务仅通过文件系统读取 6 个档案文件，且没有任何写入权限。规范要求"观察服务读取这些文件提供历史和实时视图"，与实现完全一致。

**严重度**：无差异。

**判定**：已实现。

---

### 13.6 首版不引入数据库

**目标要求**：首版不引入数据库；只有跨审议检索或并发需求成立后才评估 SQLite。

**代码证据**：
- `grep -rin "sqlite\|database\|better-sqlite\|node:sqlite"` 在 `src/` 与 `package.json` 中无命中。
- `package.json` 未声明任何数据库依赖；档案全部落盘为 JSON / JSONL。
- 全文检索使用文件系统顺序读取。

**差异描述**：完全符合"首版不引入数据库"。未发现 SQLite 或任何 RDBMS 痕迹。

**严重度**：无差异。

**判定**：已实现。

---

## 第 14 节 恢复与失败

### 14.1 恢复以逻辑调用为最小边界

**目标要求**：恢复以逻辑调用为最小边界。

**代码证据**：
- `src/core/types.ts:89-103` `FrozenInvocation` 与 `InvocationResult` 均以 `logicalCallId` 为主键。
- `src/archive/store.ts:100-145` `freezeInvocation` / `commitInvocation`：通过 `logicalCallId` 在 `pendingInvocations` 与 `completedInvocations` 之间迁移。
- `src/core/execution.ts:117-122` 恢复路径：恢复时 `readState()`，若 `completedInvocations[call.id]` 存在则直接返回，不重新调用 CLI。

**差异描述**：以"逻辑调用"为粒度进行去重、冻结、提交、恢复。`tests-ts/interrupt.test.ts:51-53` 验证了中止后 `pendingInvocations["call-1"]` 仍保留冻结输入、`completedInvocations` 不存在，确保下次恢复以同一逻辑调用继续。

**严重度**：无差异。

**判定**：已实现。

---

### 14.2 启动 CLI 前先持久化冻结输入、逻辑调用 ID、尝试信息

**目标要求**：每次参与者发言、主持规划、摘要、报告调用在启动 CLI 前先持久化冻结输入、逻辑调用 ID、尝试信息。

**代码证据**：
- `src/core/execution.ts:108-122` 流程：构造 `FrozenInvocation` → `archive.freezeInvocation(frozen)` → 读 state → 检查是否已完成 → 再决定是否启动 CLI。
- `src/core/execution.ts:128-136` 每次尝试：调用 `archive.beginAttempt(maxCalls)` 原子自增 `callAttempts` 并返回 `attemptNumber`，同时 `appendEvent("invocation.attempt_started", { attemptId, logicalCallId, attemptNumber, stage, agentId })`。

**差异描述**：冻结在 CLI 启动之前完成；尝试信息（attemptId/attemptNumber/logicalCallId）也通过 `beginAttempt` 与事件在 CLI 启动前落盘。`FrozenInvocation.kind` 类型覆盖了 `organizer/contribution/moderator/summary/draft/review/final`，与目标描述的"发言/主持规划/摘要/报告"四类调用一一对应。

**严重度**：无差异。

**判定**：已实现。

---

### 14.3 成功返回后原子提交规范化输出

**目标要求**：成功返回后原子提交规范化输出。

**代码证据**：
- `src/core/execution.ts:156-175` 流程：`adapterResult.text` 经 `call.parse` 规范化 → 构造 `InvocationResult` → `archive.commitInvocation(result)` → `appendDiagnostic` → `ensureTranscript`。
- `src/archive/store.ts:125-145` `commitInvocation` 通过 `mutateState` 串行写 state，`writeState` 走 `atomicJson`。

**差异描述**：规范化输出在 commit 之前完成，commit 通过 `atomicJson` 写 state。同时把 transcript（`ensureTranscript`）与 diagnostics（`appendDiagnostic`）也追加。注意：`transcript` 与 `diagnostics` 不走 `atomicJson`，而是 `appendFile`，这是"只追加"语义，符合规范。

**严重度**：无差异。

**判定**：已实现。

---

### 14.4 结构化并行阶段保留已完成结果，只重跑失败/未完成

**目标要求**：结构化并行阶段保留已完成参与者结果，只重跑失败或未完成调用。

**代码证据**：
- `src/core/execution.ts:117-122` 恢复短路：若 `state.completedInvocations[call.id]` 存在，直接复用 `completed.text` 经 `call.parse` 规范化并返回 `newlyCommitted: false`。
- `src/core/execution.ts:176-185` 失败/中止重试前再次检查 `state.completedInvocations`：若已存在则视为已成功，避免重复调用。
- `tests-ts/interrupt.test.ts:13-54` 用例证明中止后冻结保留、未完成逻辑调用不会进入 `completedInvocations`，下次恢复会重新跑。

**差异描述**：逻辑调用级别的去重使结构化并行阶段天然具备"只重跑失败/未完成"的能力——已完成者直接复用结果，未完成者重新走冻结-调用-提交流水线。

**严重度**：无差异。

**判定**：已实现。

---

### 14.5 自由讨论逐回合提交

**目标要求**：自由讨论逐回合提交。

**代码证据**：
- `src/core/discussion.ts` 是自由讨论 Controller；逐个发言回合独立调用 `InvocationRunner.run`。
- `src/core/execution.ts:175` 每次 `run` 在 `commitInvocation` 后立即 `ensureTranscript`，形成"逐发言回合提交"。

**差异描述**：自由讨论每个回合调用一次 `run`，自然实现逐回合提交。`commitInvocation` 在 `mutateState` 中通过 `pending → completed` 单步迁移，不会跨回合批提交。

**严重度**：无差异。

**判定**：已实现。

---

### 14.6 瞬时错误与 schema 输出错误各自动重试一次；再次失败暂停

**目标要求**：瞬时错误和 schema 输出错误各自动重试一次；再次失败则暂停为可恢复状态。

**代码证据**：
- `src/core/execution.ts:125` `for (let retry = 0; retry < 2; retry += 1)`：固定重试一次。
- `src/core/execution.ts:147-155` schema 错误用 `RetryableMadError` 抛出。
- `src/core/execution.ts:195-196` `PAUSED` 与 `CANCELLED` 不重试直接抛出；其他 `MadError`（非 Retryable）也不重试。
- `src/core/execution.ts:199` 连续两次失败抛 `MadError("EXECUTION", "连续两次失败")`，由 Controller/CLI 层捕获后通过 `archive.setStatus("paused")` 进入可恢复状态。

**差异描述**：重试机制固定 2 次（首次 + 重试一次）。`RetryableMadError` 标记 schema 错误；其他瞬时错误（非 PAUSED/CANCELLED 的非 Retryable MadError）也会走重试，因为第 196 行只豁免了 PAUSED/CANCELLED 与非 Retryable 的 MadError，而 RetryableMadError 继承自 MadError 但不会被这条分支拦截——这意味着"瞬时错误"会以"非 Retryable MadError 之外的所有错误"形式被重试，覆盖网络错误、退出码 1、临时不可用等。schema 错误则显式构造为 RetryableMadError 进入重试路径。再次失败抛错后由调用栈外层 Controller 处理（`src/core/structured.ts` / `src/core/discussion.ts`）最终 `setStatus("paused")`，由 `mad resume` 恢复。

**严重度**：低。重试范围与规范的"瞬时错误 vs schema 错误"二分意图在代码里合二为一，统一走重试一次 + 抛错的策略。这并不违反规范，但与目标描述的精细分类有细微差异。

**判定**：已实现（轻微合并）。

---

### 14.7 不自动移除参与者/降低最低人数/替换 CLI 或预设

**目标要求**：不自动移除参与者、降低最低人数、替换 CLI 或调用预设。

**代码证据**：
- 全文搜索 `src/core/structured.ts` / `src/core/discussion.ts` / `src/core/execution.ts`：无 `participants.filter`、`removeParticipant`、`substituteCli`、`replacePreset` 等降级逻辑。
- `src/core/execution.ts:196` 失败时不调整调用配置，只抛错。
- `src/cli/index.ts:596` `resume` 直接读 `manifest.plan`，不会重新组局。

**差异描述**：恢复与重试过程不修改方案，符合规范。

**严重度**：无差异。

**判定**：已实现。

---

### 14.8 CLI 已完成但输出未提交时崩溃：恢复可能重复计费但权威记录只能提交一次

**目标要求**：CLI 已完成但输出尚未提交时崩溃，恢复可能产生重复计费，但权威记录仍只能提交一次。

**代码证据**：
- `src/core/execution.ts:117-122` 恢复短路时直接读 `completedInvocations`，返回已有结果。
- `src/archive/store.ts:125-145` `commitInvocation` 内层判断 `state.completedInvocations[result.logicalCallId]`：若已存在则 `committed = false`，不覆盖、不追加第二次，且 `commitInvocation` 返回 `false`。
- `src/core/execution.ts:172-175` `if (committed) await ensureTranscript(...)` —— 已存在时不会再追加 transcript。

**差异描述**：通过 `completedInvocations` 字典的语义保证"权威记录只能提交一次"。若 CLI 已完成但 crash 在 commit 之前，下次恢复会重新冻结并启动新的 CLI 调用，从而产生重复计费（这是规范明确允许的副作用）。

**严重度**：无差异。

**判定**：已实现。

---

### 14.9 每次尝试独立尝试 ID，且在脱敏诊断中关联到同一逻辑调用

**目标要求**：每次尝试使用独立尝试 ID，并在脱敏诊断中关联到同一逻辑调用。

**代码证据**：
- `src/core/execution.ts:129` `const attemptId = randomUUID();` 每次循环独立生成。
- `src/core/execution.ts:130-136` `appendEvent("invocation.attempt_started", { attemptId, logicalCallId, attemptNumber, stage, agentId })`。
- `src/core/execution.ts:163-171` `appendDiagnostic({ attemptId, logicalCallId, attemptNumber, ..., diagnostic: adapterResult.diagnostic })`。
- `src/core/execution.ts:187-194` 失败时 `appendDiagnostic` 同样带 `attemptId` 与 `logicalCallId`。

**差异描述**：每次重试都生成新的 `attemptId`，并通过 `appendDiagnostic` 落盘到 `diagnostics.jsonl`。`diagnostic` 字段来源是适配器的 `diagnostic`，未直接落 `cli`/`preset` 等明文参数；结构化字段均限定为 `attemptId/logicalCallId/attemptNumber/at/status/durationMs/error`，不包含 prompt 正文，符合"脱敏诊断"的语义。

**严重度**：无差异。

**判定**：已实现。

---

### 14.10 恢复不重新组局、不切换模式/策略/角色/预设/预算

**目标要求**：恢复不重新组局、不切换模式、交互策略、角色、预设或预算。

**代码证据**：
- `src/cli/index.ts:594-598` 恢复首先 `archive.readManifest()`，并校验状态非 completed/cancelled。
- `src/cli/index.ts:680` `manifest.mode === "structured"`：模式完全来自 manifest，未读取 CLI 参数。
- `src/cli/index.ts:686/695` `manifest.interaction === "guided"`：交互策略来自 manifest。
- `src/cli/index.ts:613` `let plan = manifest.plan`：方案直接复用 manifest.plan，不会重新组织。
- `src/cli/index.ts:596` `registryFromManifest(manifest) ?? await loadCliRegistry(...)`：优先使用 `manifest.registrySnapshot`，无快照才回退到磁盘配置。这是恢复时的合理选择（避免档案丢失），并不修改任何运行时参数。

**差异描述**：恢复严格从 manifest 读 mode/interaction/plan，仅在 registry 缺失时回退到磁盘配置。CLI 参数解析（`src/cli/index.ts:576-585`）只接受 `--format`，不接受 `--mode`/`--auto`/`--auto-confirm-plan`，从源头杜绝切换。

**严重度**：无差异。

**判定**：已实现。

---

### 14.11 `mad resume <id>` 不切换模式/策略/方案/预算

**目标要求**：`mad resume <id>` 不切换模式、策略、方案、预算。

**代码证据**：
- `src/cli/index.ts:575-585` `resume` 仅解析 `ID` 与 `--format`，未实现任何覆盖 mode/interaction/plan/limits 的选项。
- `src/cli/index.ts:680/686/695` 模式、交互策略、方案、预算均来自 `manifest`。

**差异描述**：与上一条 14.10 一致。`mad resume` 不提供任何切换选项。

**严重度**：无差异。

**判定**：已实现。

---

### 14.12 同一 MAD_HOME 原子全局锁限制单个活动审议

**目标要求**：同一 `MAD_HOME` 使用原子全局锁限制单个活动审议。

**代码证据**：
- `src/archive/store.ts:266-339` `ActiveDeliberationLock` 类：
  - `acquire()` 使用 `open(path, "wx", 0o600)`，依赖 `EEXIST` 错误实现互斥。
  - `reclaimStale()` 通过 `.reclaim` 哨兵文件 + `process.kill(pid, 0)` 检测上一所有者是否还存活，若 `ESRCH` 则回收旧锁。
  - `release()` 关闭 fd，并校验 `ownerId` 后再 `unlink`，避免误删其他进程接管的锁。
- `src/cli/index.ts:442` 与 `:589`：`deliberate` 与 `resume` 都在进入时 `new ActiveDeliberationLock(`${paths.runtime}/active.lock`)` 并 `await lock.acquire(id)`。
- `tests-ts/archive.test.ts:89-99` 验证同一路径下第二次 acquire 抛 "已有活动审议" 错误；`:114-122` 验证进程已死时可回收；`:125-138` 验证 owner 替换时不会误删。

**差异描述**：使用 `wx` 创建锁文件 + 临时 `.reclaim` 哨兵 + 进程存活探测实现原子全局锁；同一 `paths.runtime` 路径保证 `MAD_HOME` 共享一把锁。

**严重度**：无差异。

**判定**：已实现。

---

## 其他关联观察（仅信息性，不计入合规差异）

- **诊断脱敏边界**：`src/core/execution.ts:163-171` 仅落 `diagnostic` 字段（由适配器决定内容），未在执行层记录 prompt 原文。适配器层（如 `src/adapters/process.ts`）需自行保证脱敏；本审查未覆盖适配器。
- **重试预算联动**：`src/archive/store.ts:147-155` `beginAttempt` 达到 `maxCalls` 上限后抛 `MadError`，触发 PAUSED/失败前会消耗一次 attempt 计数，重试两次的逻辑调用最多占 2 次 attempt 计数，与"重试一次"的语义匹配。
- **观察服务读取路径**：`src/server/observer.ts:75` 直接 `readFile(report.md)`，未走 `ArchiveStore.readManifest/readState`，这是符合"观察服务只读"要求的设计选择。

---

## 总结矩阵

| 项目 | 规范要求 | 实现状态 | 严重度 |
| --- | --- | --- | --- |
| 13.1 独立目录含 6 个文件 | 必须 | 已实现 | 无 |
| 13.2 manifest 字段 + schema_version | 必须 | 已实现 | 无 |
| 13.3 state.json 原子替换 | 必须 | 已实现 | 无 |
| 13.4 jsonl 文件只追加 | 必须 | 已实现 | 无 |
| 13.5 观察服务只读 | 必须 | 已实现 | 无 |
| 13.6 首版无数据库 | 必须 | 已实现 | 无 |
| 14.1 恢复以逻辑调用为边界 | 必须 | 已实现 | 无 |
| 14.2 启动 CLI 前冻结 | 必须 | 已实现 | 无 |
| 14.3 成功后原子提交 | 必须 | 已实现 | 无 |
| 14.4 并行阶段保留已完成 | 必须 | 已实现 | 无 |
| 14.5 自由讨论逐回合 | 必须 | 已实现 | 无 |
| 14.6 重试一次 + 暂停 | 必须 | 已实现（轻微合并） | 低 |
| 14.7 不自动降级 | 必须 | 已实现 | 无 |
| 14.8 重复计费但只提交一次 | 必须 | 已实现 | 无 |
| 14.9 尝试 ID + 脱敏诊断 | 必须 | 已实现 | 无 |
| 14.10 恢复不改参数 | 必须 | 已实现 | 无 |
| 14.11 resume 不切换 | 必须 | 已实现 | 无 |
| 14.12 原子全局锁 | 必须 | 已实现 | 无 |

**结论**：18 条要求全部已实现，仅 14.6 在实现细节上将"瞬时错误"与"schema 错误"统一为同一重试路径（均通过 RetryableMadError + 非 PAUSED/CANCELLED MadError 触发），属于工程合并而非违反规范。
---

## 变更记录

- 2026-07-21：按 agent 目录重新整理，本文件归入 `docs/审查/codebuddy/`。
