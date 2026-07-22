# 审查分册 #3：归档与恢复（src/archive）

**审查范围**：`src/archive/store.ts`、`src/archive/schema.ts`、`src/archive/redact.ts`、`src/archive/index.ts`
**对照架构**：`docs/TypeScript目标架构.md` §1（约束：活动审议唯一性、状态唯一写入者）、§13（透明档案）、§14（恢复与失败）
**审查方式**：独立审查，未参考 `docs/审查报告/agy` 与 `docs/审查报告/grok` 的任何内容；通过 `mcp__codegraph__codegraph_explore` 获取实现上下文。

---

## 1. 对照章节与文件映射

| 架构条款 | 主题 | 实现位置 |
| --- | --- | --- |
| §1 「TypeScript 审议进程是运行状态和正式审议档案的唯一写入者」 | 写权集中 | `src/archive/store.ts`（ArchiveStore 写入）；`src/server/observer.ts` 仅读取 + 检查点文件信箱 |
| §1 「每个应用数据根目录同时最多有一个活动审议」 | 全局活动锁 | `src/archive/store.ts` `ActiveDeliberationLock`（`acquire`/`release`） |
| §1 「页面不能发起、恢复、删除审议或修改 CLI 注册表」 | 观察页只读 | `src/server/observer.ts` 全部 GET；响应 POST 只写文件信箱 |
| §13 透明档案目录结构 | 5 类文件 | `ArchiveStore.create` 创建 manifest/state/events/transcript/diagnostics；`writeReport` 创建 report.md |
| §13 manifest 含 schema_version | schema_version 字段 | `parseDeliberationManifest` / `parseDeliberationState` / `writeManifest` / `writeState` |
| §13 events.jsonl 只追加 | 追加写 | `appendEvent`、`appendDiagnostic`、`ensureTranscript` 均使用 `appendFile` |
| §13 state.json 原子替换 | 原子写入 | `atomicJson`：`writeFile(tmp) → rename(tmp, path) → chmod` |
| §13 diagnostics.jsonl 脱敏 | 脱敏 | `appendDiagnostic` 调用 `redactDiagnostic`（`redact.ts`） |
| §14 逻辑调用为恢复最小边界 | frozen/completed 记录 | `freezeInvocation` / `commitInvocation` / `InvocationRunner.run` 双重提交检查 |
| §14 瞬时/schema 错误各自动重试一次 | 重试语义 | `InvocationRunner.run` 的 `for (let retry = 0; retry < 2; ...)` |
| §14 每次尝试独立 attemptId | attempt_id | `InvocationRunner.run`：`const attemptId = randomUUID();` 并写入 `invocation.attempt_started` 与两条 diagnostic |
| §14 恢复不重新组局、不切换模式/角色/预算 | resume 语义 | `registryFromManifest` + `resume` 路径沿用 `manifest.registrySnapshot` 与 `manifest.plan` |
| §14 同一 MAD_HOME 全局锁 | `active.lock` | `ActiveDeliberationLock`（`acquire` 含 `reclaimStale`） |
| §1 文件权限（仅当前用户访问） | 文件权限 | `mode: 0o700`（目录）、`mode: 0o600`（文件）、`chmod` 收尾 |

---

## 2. 逐条符合性判定

### 2.1 §13 透明档案目录结构（5 类文件）—— 符合

**证据**：`src/archive/store.ts:59-78`

```
ArchiveStore.create:
  mkdir(this.path, { recursive: false, mode: 0o700 });
  writeManifest(manifest);            // manifest.json
  writeState({...});                  // state.json
  writeFile(events.jsonl, "");
  writeFile(transcript.jsonl, "");
  writeFile(diagnostics.jsonl, "");
  appendEvent("archive.created");
```

`writeReport`（`store.ts:247-253`）创建 `report.md`。共 6 类文件，对应 §13 列出的全部条目。

### 2.2 §13 manifest/state 含 schema_version —— 符合（带一处弱化）

**证据**：

- `src/archive/schema.ts:123-176`：`parseDeliberationManifest` 接受 `raw.schema_version ?? raw.schemaVersion`，硬性要求 `=== 1`，否则抛 `MadError("EXECUTION", ...)`。
- `src/archive/schema.ts:213-236`：`parseDeliberationState` 同上。
- `src/archive/store.ts:84-88`：`writeState` 在写出时拆掉 `schemaVersion` 字段，重写为 `schema_version: 1`，确保归档文件持久保留版本字段。

**弱化点**：写出侧（`writeState`/`writeManifest`）硬编码 `schema_version: 1`，未基于 `state.schemaVersion` 写入。这意味着即使 `DeliberationState.schemaVersion` 类型未来放宽到 `2`，写出的归档文件依然只会落 `1`。在当前 schema_version=1 的锁定下没问题，但若未来升级 schema，写出侧与解析侧没有共用同一份权威源。

### 2.3 §13 原子替换 state.json —— 符合

**证据**：`src/archive/store.ts:39-44`

```
async function atomicJson(path, value):
  temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFile(temporary, ..., { mode: 0o600, flag: "wx" });
  rename(temporary, path);   // POSIX rename 在同一文件系统下是原子的
  chmod(path, 0o600);
```

`wx` 标志保证不会覆盖残留临时文件。`manifest.json` 同样走 `atomicJson`。

**注意**：`writeReport`（`store.ts:247-253`）也使用 `tmp → rename` 模式，但未 `chmod`，依赖 `writeFile` 的 `mode: 0o600`。这是合理的（rename 后文件继承 tmp 权限），与 §13「最终共同成果」语义吻合。

### 2.4 §13 events.jsonl / transcript.jsonl / diagnostics.jsonl 只追加 —— 符合

**证据**：

- `appendEvent`（`store.ts:237-245`）始终 `appendFile`，从未 `writeFile`/`rename` 这些路径。
- `appendDiagnostic`（`store.ts:217-223`）同上。
- `ensureTranscript`（`store.ts:204-215`）通过 `transcriptQueue` 串行化，且在追加前读全文按 `logicalCallId` 去重（同一逻辑调用不会写入两条），保证权威发言记录只追加一次。

**去重设计**：满足 §14「权威记录仍只能提交一次」。

### 2.5 §14 逻辑调用为恢复最小边界 —— 符合

**证据**：`InvocationRunner.run`（`src/core/execution.ts:104-206`）

1. 启动前 `archive.freezeInvocation(frozen)`，把 prompt / cli / preset / agent 持久化。
2. 读取 `state.completedInvocations[call.id]`，若已存在则直接复用结果，不重新调用模型（`execution.ts:123-128`）。
3. `beginAttempt` 持久化尝试编号；每次尝试 `attemptId = randomUUID()`，并写 `invocation.attempt_started` 与 `diagnostics.jsonl` 一条记录（`execution.ts:134-201`）。
4. CLI 成功返回后 `commitInvocation` 原子提交，且仅在 `completedInvocations[id]` 不存在时提交（`store.ts:115-135`）。
5. catch 分支再次检查 `completedInvocations`，若已有权威记录则复用并跳过重试（`execution.ts:183-191`）。
6. 重试上限 `retry < 2`，即瞬时/schema 错误各自动重试一次后失败（`execution.ts:131, 204-205`）。

这与 §14 全部要点对应：冻结 → 重试 → 唯一提交 → 恢复时复用已完成结果。

### 2.6 §14 每次尝试独立 attemptId、关联同一 logicalCallId —— 符合

**证据**：`src/core/execution.ts:135-142, 169-177, 193-200`

- `attemptId = randomUUID()`。
- `appendEvent("invocation.attempt_started", { attemptId, logicalCallId, attemptNumber, ... })`。
- `appendDiagnostic({ attemptId, logicalCallId, attemptNumber, ..., status: "completed"/"failed" })`。

脱敏诊断记录与尝试 ID、逻辑调用 ID 显式关联。

### 2.7 §14 恢复不重新组局、不切换模式/角色/预算 —— 符合

**证据**：

- `registryFromManifest`（`src/cli/index.ts:163-196`）从 `manifest.registrySnapshot` 重建 `CliRegistry`，不重新读取 `clis.toml`。
- 恢复路径沿用 `manifest.plan`（或 `manifest.planning.candidatePlan`）作为本次审议的方案。
- 模式、交互策略、角色、预算全部从 `manifest`/`planning.limits` 读取，不接受命令行覆盖。

### 2.8 §14 同一 MAD_HOME 全局锁 —— 部分符合（实现存在，但与架构描述存在一个语义偏差，见偏差 §3.1）

**证据**：`src/archive/store.ts:265-338`

- 文件路径 `${paths.runtime}/active.lock`（`src/cli/index.ts:443`），runtime 位于 `MAD_HOME` 下（`src/core/paths.ts:19-35`）。
- `acquire` 使用 `open(path, "wx", 0o600)`，失败时仅尝试一次 `reclaimStale`（针对残留 pid 文件），仍失败抛 `MadError("LOCKED", "当前 MAD_HOME 已有活动审议")`。
- `release` 检查 `ownerId` 后再 unlink，避免误删被其他进程抢占的锁。

**注意**：`src/core/execution.ts:27` 另有一处名为 `acquire` 的内部方法（Semaphore 实现），与 `ActiveDeliberationLock.acquire` 是不同语义。这是命名冲突，不是 bug。

### 2.9 §13 diagnostics.jsonl 脱敏 —— 部分符合（见偏差 §3.4）

**证据**：`src/archive/redact.ts:1-43`

- 键名匹配 `SENSITIVE_KEY = /(authorization|api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)/i`。
- 字符串值经 `redactString` 处理：匹配 `api_key=xxx`、`Bearer xxxx`、`sk-/xai-/ghp-/github_pat-/glpat-` 前缀 token，并对所有 `process.env` 中含 TOKEN/KEY/SECRET/PASSWORD 且长度 ≥8 的值做整体替换。
- 嵌套深度上限 8，数组长度上限 100，字符串长度上限 4000。

`appendDiagnostic`（`store.ts:217-223`）确实在写入前调用 `redactDiagnostic`。但仍有盲区（见 §3.4）。

### 2.10 §1 文件权限仅当前用户访问 —— 符合

**证据**：

- 目录：`mkdir(..., { mode: 0o700 })`，并在 `cli/index.ts` 中通过 `ensurePrivateDirectory` 二次 `chmod(0o700)`。
- 文件：`writeFile(..., { mode: 0o600, flag: "wx" })`，并在 `atomicJson` 中 `chmod(path, 0o600)`。
- 锁文件：`open(path, "wx", 0o600)`（`store.ts:275`）。

权限统一 0o700/0o600，符合 §1「仅限当前用户访问」语义。

---

## 3. 偏差清单

### P0（阻断级：会导致系统无法正确完成关键功能）

> 审查未发现 P0 级偏差。所有路径上的原子写、唯一提交、恢复跳过已完成调用、§14 的重试与解锁语义均正确实现。
> 详见下文 P1/P2。

### P1（重要偏离：影响正确性或安全边界，但不阻断关键流程）

#### P1-1 全局活动锁 `ActiveDeliberationLock.acquire` 缺少「跨进程去重 + 进程 PID 真实性」校验，导致死锁残留时无法回收（潜在场景）

- **架构条款**：§14「同一 `MAD_HOME` 使用原子全局锁限制单个活动审议」。
- **证据**：`src/archive/store.ts:271-289`
- **描述**：`acquire` 在 `open(path, "wx", ...)` 失败后仅尝试一次 `reclaimStale`。`reclaimStale` 通过 `process.kill(pid, 0)` 探测 PID 是否存在，但若上一个活动进程是一个已死掉的 PID（被 OS 复用给另一个无关进程），`process.kill(pid, 0)` 会成功，导致锁永远无法回收，新审议无法启动。
- **影响**：在极少数极端场景下（OS 高速复用 PID + 锁文件残留），会出现永久「活动审议」误判。
- **修复建议**：在锁文件中加入「创建时间戳」或「ownerId + nonce」，并在 `reclaimStale` 中额外检查 ownerId 与上次写盘时间间隔（例如超过 `maxCalls × timeoutSeconds` 或超过某个保守阈值才允许回收）。或者借鉴 `fcntl(F_OFD_GETLK)` 风格的写入者心跳。

#### P1-2 `freezeInvocation` 在并发场景下与 `mutateState` 协作存在幂等但缺一致性的边界

- **架构条款**：§14「恢复以逻辑调用为最小边界」。
- **证据**：`src/archive/store.ts:90-113` 与 `src/core/execution.ts:104-122`。
- **描述**：`InvocationRunner.run` 先 `freezeInvocation`，再 `readState`，再判断 `completedInvocations` 是否已存在。若两个并发 resume 同时启动（理论上全局锁阻止此情况，但 §14 的语义是「恢复从档案恢复」），它们都会通过 `freezeInvocation` 的「已存在则保持原样」分支并继续 —— 这本身没问题。然而 `freezeInvocation` 内部 `mutateState` 与 `commitInvocation` 的 `mutateState` 通过同一个 `mutationQueue` 串行化（`store.ts:48`），但 `ensureTranscript` 的 `transcriptQueue`（`store.ts:49`）与 `appendEvent`（直接 `appendFile`）**未串行化**。这意味着 `commitInvocation` 的 mutationQueue 完成、紧接着 `appendEvent("invocation.committed")` 可能在另一进程的 `appendEvent` 之后落盘（事件交错）。事件 jsonl 本就允许交错，不算错误，但 §13 表述「只追加」未禁止交错，因此这一点不构成 bug，仅作记录。
- **影响**：低——事件流可能出现交错顺序；不影响权威 state 与 transcript。
- **修复建议**：如需严格顺序，将 `appendEvent` 也串行化入同一队列（或在 `mutateState` 的尾部附加事件，由 mutationQueue 统一追加）。

#### P1-3 脱敏对 `Authorization` 之外的 HTTP 风格头（如 `Cookie`、`Proxy-Authorization`、自定义 `X-Api-Token`）未覆盖

- **架构条款**：§13「diagnostics.jsonl 只追加脱敏调用诊断」。
- **证据**：`src/archive/redact.ts:1-17`
- **描述**：`SENSITIVE_KEY` 仅匹配 authorization / api_key / access_token / auth_token / token / secret / password。HTTP `Cookie: session=xxxx` 不会触发键名匹配；如果调用诊断中以 `Cookie:` 形式出现，redactString 的正则也不会匹配（因为没有 `Cookie` 在键名列表中）。`Proxy-Authorization` 同样不被覆盖。
- **影响**：诊断文件可能泄漏会话 Cookie。
- **修复建议**：将 `cookie`、`proxy[-_]authorization`、`set-cookie` 加入 `SENSITIVE_KEY`，或在 `redactString` 中加入匹配常见 header 名（大小写不敏感）。

### P2（一般偏离或可改进项）

#### P2-1 `writeState` 与 `writeManifest` 硬编码 `schema_version: 1`

- **架构条款**：§13「manifest.json ... schema_version」「schema_version 字段保留」。
- **证据**：`src/archive/store.ts:84-88, 198-202`
- **描述**：解析侧使用 `state.schemaVersion` 类型字段，但写出侧硬编码 `schema_version: 1`，未来升级 schema 时需同步改动两处且解析/写出不在同一份权威源。
- **影响**：未来 schema 升级时易遗漏。
- **修复建议**：把 `schema_version` 提取为常量 `CURRENT_SCHEMA_VERSION = 1`，由解析与写出共用。

#### P2-2 `readState` 在状态文件损坏/截断时直接抛 `JSON.parse` 错误，未捕获为 `EXECUTION` 错误

- **架构条款**：§14 恢复语义「失败时持久化可恢复状态」。
- **证据**：`src/archive/store.ts:80-82`
- **描述**：`readState` 仅 `JSON.parse`，未对截断/损坏做容错；若 `state.json` 在写入过程中被截断（极端情况：rename 已成功但文件内容为空，因为 `wx` + rename 顺序下不应发生；但若用户在文件层面操作），`JSON.parse` 抛出 `SyntaxError`，未映射为 `MadError`。
- **影响**：观察页与 resume 都会因裸 SyntaxError 崩溃。
- **修复建议**：在 `readState`/`readManifest` 入口捕获 `SyntaxError` 并转换为 `MadError("EXECUTION", "档案损坏")`。

#### P2-3 `events.jsonl` 的事件类型 `data` 字段未做 schema 校验，仅 `parseArchiveEvent` 校验顶层

- **架构条款**：§13 透明档案的「只追加生命周期事件」。
- **证据**：`src/archive/schema.ts:238-246`、`src/archive/store.ts:237-245`
- **描述**：`parseArchiveEvent` 只校验 `id`/`at`/`type` 三个字段；`data` 透传为 `unknown`。这意味着事件流可以携带任意结构，目前由写入方自约束。
- **影响**：低。事件仅用于追溯与调试，无需强 schema。
- **修复建议**：可选为关键事件类型（`invocation.frozen` / `invocation.committed` / `checkpoint.pending` / `checkpoint.responded`）增加类型化校验，提升可观测性。

#### P2-4 `appendDiagnostic` 未串行化（与 §2.6 中 P1-2 同源，但针对 diagnostics.jsonl 单独列出）

- **架构条款**：§13 diagnostics.jsonl 只追加。
- **证据**：`src/archive/store.ts:217-223`
- **描述**：直接 `appendFile`，未通过任何队列。同一进程内多次 `appendDiagnostic` 调用之间非原子，但 `appendFile` 本身在内核中是原子的（POSIX `O_APPEND`），文件不会撕裂。多进程并发写同一 jsonl 时行可能交错，但本场景下全局锁阻止多进程同时写。
- **影响**：实际不会触发；标记为可改进项。
- **修复建议**：若希望 diagnostics 与 events 严格同步，将 `appendDiagnostic` 也加入 `mutationQueue` 或单独 `diagnosticQueue`。

#### P2-5 `ActiveDeliberationLock.reclaimStale` 中的 `reclaim` 文件在并发 resume 场景下存在 TOCTOU

- **架构条款**：§14 全局活动锁。
- **证据**：`src/archive/store.ts:306-337`
- **描述**：`reclaimStale` 通过创建 `reclaimPath` 来选举回收权，但若两个进程同时尝试 reclaim，第二个进程的 `open(reclaimPath, "wx")` 会失败而返回 `false`。这正是 TOCTOU 的正确处理方式（乐观锁），但配合「PID 不存在才回收」语义，可能出现两个进程都通过 `process.kill(pid, 0)` 检查，然后同时 `unlink` 锁文件，导致新审议产生两个并发进程。这与「全局单活动审议」原则冲突。
- **影响**：极低概率，仅在 OS 恰好回收原 PID 时发生。
- **修复建议**：在 `unlink` 后立即尝试 `open(lock, "wx")`，若失败则放弃本次 reclaim；或者采用 `link(lock, reclaimPath)` 作为「原子声明所有权」。

#### P2-6 `redact.ts` 的 `MAX_STRING_LENGTH = 4000` 在错误堆栈很长时只保留头部，可能丢失关键上下文

- **架构条款**：§13 脱敏诊断。
- **证据**：`src/archive/redact.ts:4, 16`
- **描述**：错误堆栈通常在文件路径、URL 等信息之后才出现机密信息；头部截断可能让诊断读起来非常费解。
- **影响**：可观测性下降。
- **修复建议**：将 `redactString` 改为「先做敏感替换，再截断到 4000 字符并附加 `(truncated, original length N)` 标记」。

---

## 4. 分册结论摘要

### 总体评价

`src/archive` 实现的**核心契约**与 §13、§14 高度一致：

- 五类档案文件结构、原子写、只追加、唯一提交、按 `logicalCallId` 跳过已完成调用、attemptId 与 logicalCallId 关联、§14 重试语义、§1 文件权限与全局锁均正确实现。
- `parseDeliberationManifest`/`parseDeliberationState` 对 `schema_version` 的解析与校验完整。
- 恢复路径（`registryFromManifest` + `resume`）不从 `clis.toml` 重新读取注册表，符合「恢复不重新组局」。
- 全局活动锁基于 `O_EXCL` 创建原子文件 + ownerId 校验，符合 §14「原子全局锁」语义。

### 主要风险

1. **P1-1 全局锁在极端 PID 复用情况下可能误判永久活动**（极少触发，但存在）。建议为锁文件加入时间戳或心跳字段。
2. **P1-3 脱敏对 `Cookie` / `Proxy-Authorization` 头未覆盖**，可能泄漏会话 Cookie。优先修复。

### 未发现的问题

- 未发现 P0 级偏差：所有路径上的原子写、唯一提交、跳过已完成调用、§14 重试与解锁语义均正确。
- 写权限集中：所有 `state.json`、`manifest.json`、`transcript.jsonl`、`diagnostics.jsonl`、`events.jsonl`、`report.md`、`active.lock` 的写入均封装在 `src/archive/*` 与 `src/cli/*` 中。`src/server/observer.ts` 只读 `transcript.jsonl` 与 `report.md`，不修改任何档案文件。观察页通过 `publishExclusiveJson`（文件信箱）发送响应，遵守 §1「页面不能发起、恢复、删除审议或修改 CLI 注册表」。
- 文件权限：目录 0o700、文件 0o600、锁 0o600，与 §1「仅限当前用户访问」一致。

### 推荐修复顺序

1. P1-3（脱敏 `Cookie`）—— 安全敏感，修复成本低。
2. P1-1（全局锁 PID 复用）—— 加时间戳即可。
3. P2-1 / P2-2 / P2-5 —— 长期可维护性。

**变更时间**：2026-07-22
**变更概要**：对照 §13、§14 与 §1 约束完成 src/archive 独立审查；归档结构、原子写、唯一提交、恢复语义、schema_version、文件权限均符合；识别 3 项 P1（含 1 项安全脱敏盲区）与 6 项 P2；未发现 P0 级阻断偏差。