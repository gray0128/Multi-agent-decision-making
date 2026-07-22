# 审查报告：透明档案与恢复/失败（§13 / §14 / §1 相关）

**审查员**：Grok Build 独立代码审查  
**对照基准**：`docs/TypeScript目标架构.md` 第 13、14 节及第 1 节相关约束  
**忽略**：其他审查报告意见  
**审查日期**：2026-07-22  

---

## 1. 范围与方法

### 1.1 对照范围

| 基准 | 要点 |
|------|------|
| §1 | 审议进程是运行状态与正式档案的唯一写入者；每 `MAD_HOME` 最多一个活动审议 |
| §13 | 透明档案目录六件套；观察服务只读；首版无数据库 |
| §14 | 逻辑调用为恢复最小边界；并行保留已完成；自由讨论逐回合提交；瞬时/schema 各重试一次后暂停；不自动改组；重复计费但权威只提交一次；独立 attemptId；恢复不切换模式/方案/预算；原子全局锁 |

### 1.2 审查对象

| 类别 | 路径 |
|------|------|
| 档案层 | `src/archive/store.ts`, `schema.ts`, `redact.ts`, `index.ts` |
| 调用边界 | `src/core/execution.ts` |
| 恢复路径 | `src/core/structured.ts`, `discussion.ts`, `outcome.ts`, `context.ts` |
| CLI / 锁 / resume | `src/cli/index.ts` |
| 观察只读 | `src/server/observer.ts`, `mailbox.ts` |
| 测试 | `tests-ts/archive.test.ts`, `execution.test.ts`, `interrupt.test.ts`, `structured.test.ts`, `discussion.test.ts`, `cli-e2e.test.ts`（恢复相关） |

### 1.3 方法

逐条对照架构约束，以源码与测试为证据；只记录实现与基准之间的符合/偏差，不引入其他审查结论。

---

## 2. 符合项（证据）

### 2.1 透明档案目录与文件角色（§13）— 符合

`ArchiveStore.create` 在独立目录下创建 `manifest.json`、`state.json`，并预创建只追加文件 `events.jsonl` / `transcript.jsonl` / `diagnostics.jsonl`：

```59:78:src/archive/store.ts
  public async create(manifest: DeliberationManifest): Promise<void> {
    await mkdir(this.path, { recursive: false, mode: 0o700 });
    await this.writeManifest(manifest);
    await this.writeState({
      schemaVersion: 1,
      status: "planning",
      // ...
    });
    await Promise.all(
      ["events.jsonl", "transcript.jsonl", "diagnostics.jsonl"].map((name) =>
        writeFile(join(this.path, name), "", { flag: "wx", mode: 0o600 }),
      ),
    );
    await this.appendEvent("archive.created");
  }
```

- **manifest**：含身份 `id`、`mode`、`interaction`、可选 `plan` / `planning` / `workspace` / `registrySnapshot`，落盘字段为 `schema_version`（见 `writeManifest` / `parseDeliberationManifest`）。
- **state.json**：`atomicJson` 写临时文件后 `rename`，原子替换可恢复状态（`pendingInvocations` / `completedInvocations` / `checkpointDecisions` / `callAttempts` 等）。
- **events / transcript / diagnostics**：`appendFile` 只追加；transcript 按 `logicalCallId` 幂等 `ensureTranscript`。
- **report.md**：完成时 `writeReport` 原子写入（structured / discussion 在 `setStatus("completed")` 前调用）。
- **无数据库**：档案与观察均基于目录文件。

测试：`tests-ts/archive.test.ts`（创建、冻结/提交、schema_version 落盘、脱敏、schema 校验）。

### 2.2 观察服务只读档案（§13 / §1）— 符合

`observer.ts` 的 `detail` 仅 `readManifest` / `readState` / `readEvents` / 读 `transcript.jsonl` / `report.md`；检查点响应写入 `runtime/checkpoints/*.response.json`（信箱），不修改审议档案。  
§1「审议进程唯一写入者」在档案路径上成立。

### 2.3 逻辑调用为最小恢复边界（§14）— 符合

`InvocationRunner.run` 顺序：

1. 组装 `FrozenInvocation` → `archive.freezeInvocation`（启动 CLI 前持久化冻结输入与 `logicalCallId`）
2. 若已有 `completedInvocations[id]` → 直接返回权威输出，不重调 CLI
3. `beginAttempt` + `appendEvent("invocation.attempt_started")`（尝试序号与 `attemptId`）
4. CLI 成功 → `commitInvocation`（原子写入规范化结果，已存在则返回 `false`）
5. 诊断写入 `diagnostics.jsonl`（含 `attemptId` + `logicalCallId`）
6. 仅首次 commit 时 `ensureTranscript`

证据：`src/core/execution.ts` 约 104–206 行；`store.freezeInvocation` / `commitInvocation` 幂等语义。  
测试：`archive.test.ts`（只提交一次）、`execution.test.ts`（权威结果后不二次 invoke）、`interrupt.test.ts`（中断后 pending 保留冻结输入）。

### 2.4 结构化并行：保留已完成，只重跑未完成（§14）— 符合

并行阶段逻辑 ID 稳定：`structured:${stage}:${agent.id}`。  
`settleAllOrThrow` 等待同批结束后再失败；成功者已 `commitInvocation`。恢复时 `runner.run` 对已完成 ID 短路。

证据：`structured.ts` `parallel`；`cli-e2e.test.ts`「resumes only unfinished logical calls after a double invocation failure」；`structured.test.ts` 完整跑通后二次 `run` 不增加 `callAttempts` / 不重复 invoke。

### 2.5 自由讨论逐回合提交（§14）— 符合

`DiscussionController.speak` 顺序 `await this.runner.run(...)`，每回合独立逻辑 ID（如 `discussion:speech:${phase}:${round}:${agent.id}`），成功后才推进下一回合；主持规划 / 报告同走 `InvocationRunner`。

### 2.6 瞬时错误与 schema 错误各自动重试一次（§14）— 符合

- 循环 `retry < 2`（共两次尝试）。
- schema 解析失败包装为 `RetryableMadError`。
- 瞬时：`RetryableMadError`（超时、`isLikelyTransientFailure` 分类的退出/错误）；确定性 `MadError` 不重试。
- 两次仍失败 → `连续两次失败`；控制器 `catch` 将非 `CANCELLED` 置为 `paused`。

证据：`execution.ts` 130–205；`process.ts` 超时 → `RetryableMadError`；`generic.ts` / `codex.ts` 瞬时分类；`execution.test.ts` schema 恰好重试一次、确定性错误不重试。

### 2.7 不自动改组 / 恢复不切换模式方案预算（§14）— 符合

- 失败路径无移除参与者、降低人数、替换 CLI/preset 的逻辑。
- `resume` 从 `manifest` 读取 `mode` / `interaction` / `plan` / `planning.limits` / `registrySnapshot`；有快照时 `registryFromManifest` 重建注册表，不依赖当前可改写的 live 配置覆盖已确认方案。
- e2e 在 resume 前故意破坏 `clis.toml` 仍能完成（依赖档案内 snapshot）。

### 2.8 重复计费可能、权威只提交一次（§14）— 符合

CLI 成功但 `commit` 前崩溃可再计费；`commitInvocation` 若已 completed 返回 `false`；runner 在异常路径再次检查 `completedInvocations` 并返回权威结果。transcript 按 `logicalCallId` 去重。

### 2.9 独立尝试 ID 关联逻辑调用（§14）— 符合

每次尝试 `attemptId = randomUUID()`，写入 `invocation.attempt_started` 事件与 `appendDiagnostic({ attemptId, logicalCallId, ... })`；诊断经 `redactDiagnostic` 脱敏。

### 2.10 原子全局锁：每 MAD_HOME 一个活动审议（§1 / §14）— 符合

`ActiveDeliberationLock`：`open(path, "wx")` 创建锁文件；冲突且 owner PID 不存在时可 `reclaimStale`；`deliberate` / `resume` 均在预检与业务前 `acquire`，`finally` `release`。  
测试：`archive.test.ts` 单活动锁 / 僵死回收 / ownerId 释放安全；`cli-e2e` resume 在持锁时退出码 5 且零 CLI 调用。

### 2.11 中断与失败后的可恢复状态（部分）— 符合

- 逻辑调用中 SIGINT：`PAUSED`，pending 保留，无检查点决策粘滞 → e2e Ctrl-C 后 resume 完成。
- 双次调用失败：status `paused` → resume 只重跑未完成。
- 规划阶段中断：manifest 保留 `planning`，resume 续组局/确认。

---

## 3. 偏差（严重度 + 证据）

### 3.1 【高】检查点动作 `pause` 被持久化为终局决策，resume 无法越过该检查点

**基准**：§10/§14 暂停应进入**可恢复**状态；`mad resume` 应从档案继续，而非永久卡在同一次「暂停」决策上。

**实现**：

1. CLI 协调检查点在收到 `pause` 后调用 `recordCheckpointDecision(key, { action: "pause", ... })`（`src/cli/index.ts` `coordinatedStructuredCheckpoint` / `coordinatedDiscussionCheckpoint`）。
2. `StructuredController.pauseAt` / `DiscussionController.atBoundary` 若读到已记忆决策且 `action === "pause"`，**直接再次抛出** `PAUSED`，不重新征求用户/观察页。
3. 信箱在外部 `AbortSignal` 上会 `submit(checkpointId, "pause")`（`mailbox.ts` 第 64 行），SIGINT 落在检查点等待期时同样会写入 pause 决策。

**后果**：用户在 guided 检查点选择「暂停」、或检查点等待期间 Ctrl-C → 档案 `status=paused` 且 `checkpointDecisions[key].action=pause` → `mad resume` 一到该屏障再次立即暂停，**无法完成恢复**。  
对比：逻辑调用中断（无 pause 决策）可正常 resume（e2e 已覆盖），形成行为分裂。

**建议修复方向**（供实现参考，非本次改码）：

- 不要把 `pause` 记入「已接受的推进决策」；或 resume 时忽略 `action===pause` 并清除 `pendingCheckpoint` 后重新展示检查点；
- 信箱 abort 提交 pause 与「用户选择 continue」应区分语义。

**测试缺口**：无「checkpoint pause → resume 应继续/重新提示」用例。

---

### 3.2 【中】自由讨论恢复依赖内存重放 + 冻结 prompt 一致性，缺少专用回归

**基准**：§14 自由讨论逐回合提交、恢复不丢权威记录。

**实现优点**：每回合 commit；逻辑 ID 含 phase/round；completed 短路时 `freezeInvocation` 对已完成 ID 不校验 prompt。

**风险**：

- 未完成（仍在 `pendingInvocations`）的讨论/摘要调用，resume 时会用重建的 `SharedContextManager` 再算 prompt；若与冻结 prompt 不一致则抛「逻辑调用冻结输入不一致」。
- `discussion.test.ts` **没有** pause/失败后 resume 重放用例（structured / cli-e2e 偏结构化）。
- 暂停路径额外写 `discussion.ended`（`endReason: "paused"`），恢复成功后再写一次 ended，事件流可出现多次结束语义（审计噪音，非功能阻断）。

**严重度**：中（设计上多数路径可重放，但边界与测试不足）。

---

### 3.3 【低】`pendingInvocations` / `completedInvocations` 读入时未做深层 schema 校验

`parseDeliberationState` 对二者仅 `record()`（任意对象），不校验 `FrozenInvocation` / `InvocationResult` 字段。损坏或手改档案可能在运行期才失败，削弱「可恢复状态」的可预期性。

证据：`src/archive/schema.ts` 约 229–230 行。

---

### 3.4 【低 / 说明性】`report.md` 仅在完成时创建

§13 列出 `report.md` 为档案组成部分；实现完成前目录中可无该文件，观察服务对缺失 `report.md` 按空串处理。与「最终共同成果」语义一致，**不判为功能偏差**，记为文档/目录完备性说明项。

---

### 3.5 【低】运行期非取消错误一律标为 `paused`，鲜用 `failed`

`StructuredController` / `DiscussionController` 对非 `CANCELLED` 一律 `setStatus("paused")`（含确定性 `EXECUTION`）。利于一律可 resume，但与状态机中 `failed` 的区分偏弱；规划阶段 CLI 仍会标 `failed`。非 §14 硬性违背，记可观测性/运维语义偏差。

---

## 4. 风险与建议

| 优先级 | 项 | 建议 |
|--------|----|------|
| P0 | 检查点 pause 粘滞 | 修正决策持久化语义；补 e2e：guided pause → resume → continue → completed |
| P1 | 自由讨论恢复 | 增加 discussion 中途失败/中断后 resume 测试；对 pending 调用优先使用冻结 prompt 再 invoke，避免重建 prompt 不一致 |
| P2 | state 内 invocation 结构校验 | 在 `parseDeliberationState` 中校验 frozen/completed 记录形状 |
| P2 | discussion.ended 语义 | 仅在真正结束（完成/取消/达上限）写 ended；暂停用 `deliberation.paused` 即可 |
| 保持 | 逻辑调用边界 / 锁 / 只读观察 / 脱敏 | 已对齐，变更时勿削弱 commit 幂等与 resume 锁序 |

---

## 5. 评分

| 维度 | 分数 (0–10) | 说明 |
|------|-------------|------|
| §13 透明档案结构与原子/只追加语义 | **9.0** | 六件套职责清晰，原子 state/report，脱敏诊断到位；report 延后创建可接受 |
| §13 / §1 唯一写入者与无库观察 | **9.5** | 观察只读档案；信箱与档案分离正确 |
| §14 逻辑调用边界、幂等提交、attemptId | **9.0** | freeze → attempt → invoke → commit 清晰；权威单次提交扎实 |
| §14 结构化并行恢复 | **9.0** | ID 稳定 + completed 短路 + e2e 覆盖 |
| §14 自由讨论逐回合与恢复 | **7.0** | 逐回合提交正确；恢复重放与测试偏弱 |
| §14 重试与失败暂停 | **8.5** | 瞬时/schema 双次重试与 paused 符合；确定性错误也 paused 略宽 |
| §14 恢复不改组/不切换模式预算 | **9.0** | manifest + registrySnapshot + resume 路径正确 |
| §1 / §14 单活动全局锁 | **9.0** | O_EXCL + 僵死回收 + resume 锁前预检 |
| **检查点暂停可恢复性** | **4.0** | **关键功能缺陷**：pause 决策导致 resume 死循环式再暂停 |
| **综合（加权）** | **7.8 / 10** | 档案与逻辑调用恢复主干扎实；检查点 pause 粘滞显著拉低可恢复性完整度 |

### 综合结论

实现与 §13 透明档案、§14 逻辑调用边界、并行保留已完成、重试策略、全局锁、唯一写入者等**主干约束高度对齐**，并有较好单元/e2e 支撑。  
**阻断级偏差**是 guided/信箱路径将 `pause` 固化进 `checkpointDecisions` 后，resume 无法越过该检查点——这直接违反「暂停为可恢复状态」的产品语义。修复该点并补齐自由讨论恢复测试后，本域可达到与架构描述基本一致的完成度。

---

## 变更记录

| 时间 | 概要 |
|------|------|
| 2026-07-22 | 初稿：对照 §13/§14/§1 审查 archive、execution、structured/discussion 恢复、CLI resume/锁与相关 tests-ts；记录检查点 pause 粘滞等高中低偏差与评分。 |
