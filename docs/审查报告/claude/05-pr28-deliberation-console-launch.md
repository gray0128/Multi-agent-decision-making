# 审查分册 #5：审议控制台发起与配置 PR#28

> 审查对象：`feat: 在审议控制台中发起并配置审议`（PR#28，仓库 `gray0128/Multi-agent-decision-making`，分支 `codex/deliberation-console-launch`，head SHA `5ec1ac2296c01dcf2d4fe72d6f8ee352f7ee909d`）
> 变更主轴：将只读观察页升级为本地审议控制台（web launcher + 三步向导），由服务进程通过持久化 `launches/*.json` 协调记录派生独立审议 CLI 进程；CLI 把 `plan_confirmation` 升级为版本绑定的检查点，支持网页发起、修改、确认、重新组局与取消；同步更新 `CONTEXT.md`/`README.md`/`docs/adr/0018*.md` 与 `src/archive/schema.ts`、`src/core/types.ts`、`src/cli/index.ts`、`src/server/{observer,mailbox,launch-coordinator}.ts`、`src/web/index.ts`。
> 对照基线：上一轮已落地的整合报告 [`docs/审查报告/00-整合指导报告.md`](./../00-整合指导报告.md) 的 A/B/C/D 分级；以及 [`docs/TypeScript目标架构.md`](./../../TypeScript目标架构.md) §2（总体结构）、§3（单包代码结构）、§5（固定组局阶段）、§6（CLI 与交互模式）、§7（本地服务）、§16（stdout/stderr 与退出码），以及 [`docs/TypeScript实现与验收.md`](./../../TypeScript实现与验收.md) 的实现与接管验收。
> 审查方法：在 head SHA 上重读 `src/server/{observer,mailbox,launch-coordinator,index}.ts`、`src/cli/index.ts`、`src/web/index.ts`、`src/core/{types,paths,limits,errors}.ts`、`src/archive/{schema,store}.ts` 与 `tests-ts/{observer,cli-e2e}.test.ts`；通过 `mcp__codegraph__codegraph_explore` 跟踪 `LaunchCoordinator`、`CheckpointMailbox.wait`、`confirmPlan`、`recordCheckpointDecision` 的调用路径与影响面；执行 `npm run typecheck`、`npm run build`、`npx vitest run` 与 `git diff --check`。
> 独立性：本次审查独立完成，参照了 `00-整合指导报告.md` 的分级口径，未参考 `docs/审查报告/agy`、`docs/审查报告/grok` 对 PR#28 的任何评论。

## 1. 变更结构与文件映射

| 变更主题 | 关键文件 | 涉及架构条款 |
| --- | --- | --- |
| 控制台发起 + 独立进程派生 | 新增 `src/server/launch-coordinator.ts`；`src/server/observer.ts` 增加 `/api/launch-options`、`/api/launches`、`/api/launches/:requestId`、`/api/deliberations/:id/agent-id` 路由；`src/server/index.ts` 导出新模块；`src/cli/index.ts:557-578` 在 `deliberate` 创建 `mailbox`，新增 `--id`、`--web-plan` 选项 | §2、§5、§6、§7 |
| `plan_confirmation` 版本绑定检查点 | `src/cli/index.ts:206-322` 重写 `confirmPlan`；`src/server/mailbox.ts` 接受 `data`；`src/server/observer.ts:399-411` 处理 `candidateVersion` 校验；`src/archive/schema.ts:170-172`、`src/core/types.ts:85` 增加 `candidateVersion` | §5、§6、§16 |
| 错误状态在 `waiting_checkpoint` 时正确归档 | `src/cli/index.ts:605-612`、`src/cli/index.ts:768-774` `catch` 同时把 `waiting_checkpoint` 计入可中断归档 | §6、§16 |
| 启动协调记录与进程互斥 | `src/server/launch-coordinator.ts:48-91` `defaultProcessLauncher` 用 `process.execPath`/`process.argv[1]`/`process.execArgv` 重派生 `node --import tsx dist/cli/index.js deliberate ...`；`launch-coordinator.ts:104-211` 队列串行、原子写 `runtime/launches/{requestId}.json`、50 ×100ms 等待档案转 planning | §6、§7 |
| 控制台前端 | `src/web/index.ts` 新增 `<button id="launch-deliberation">`、三步向导、`plan_confirmation` 步骤 3 编辑器、`sessionStorage` 草稿、`/api/launches` 轮询 | §7、§9 |
| 文档/术语更新 | `CONTEXT.md` 新增 `审议议题`、`审议控制台` 领域词；`README.md` 第 6/8 节改写；新增 `docs/adr/0018-由审议控制台发起独立审议进程.md` | ADR |
| 测试 | `tests-ts/cli-e2e.test.ts` 新增 3 个用例：`requires a version-bound web plan confirmation before automatic execution`、`cancels a web planning checkpoint while preserving its archive and releasing the lock`、`launches a detached planning process from the authenticated console HTTP boundary`；`tests-ts/observer.test.ts` 新增 `exposes authenticated safe launch options and the three-step entry`、`idempotently launches an independent planning deliberation`、`persists and redacts a spawn failure without reporting a successful launch` | 验收 |

变更 head 关键事实：

- 状态：单 commit `5ec1ac2296c01dcf2d4fe72d6f8ee352f7ee909d`，无 review、无 comment、无 `statusCheckRollup`（仓库未配置 CI）；同作者（PR 作者与 canonical 本机 reviewer 同一账号 `gray0128`）；写权限完备。
- 关闭了 `#18`–`#27`，未在 `docs/审查报告/` 前置目录中找到对应 issue 描述；本次审查按代码与 ADR-0018 内容判定。

## 2. 执行验证

| 验证 | 命令 | head 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（`tsc -p tsconfig.json --noEmit` 无输出） |
| 构建 | `npm run build` | 通过（`tsc -p tsconfig.json` + `chmod 755 dist/cli/index.js`） |
| 单元 + 集成测试 | `npx vitest run` | 16 个测试文件 / 113 个测试全部通过；新增 `mad CLI end to end > requires a version-bound web plan confirmation before automatic execution`、`cancels a web planning checkpoint while preserving its archive and releasing the lock`、`launches a detached planning process from the authenticated console HTTP boundary`，以及 `authenticated observer service > exposes authenticated safe launch options and the three-step entry`、`idempotently launches an independent planning deliberation`、`persists and redacts a spawn failure without reporting a successful launch` 均通过 |
| Whitespace 检查 | `git diff --check` | 无冲突标记 |

测试在 head 上覆盖了关键变更路径：

- 版本绑定的 `plan_confirmation` 替换、校验失败、`regroup`、最终 `confirm` 闭环（`tests-ts/cli-e2e.test.ts:1152-1292`）。
- 网页规划被取消时档案保留、状态落 `cancelled`、`runtime/active.lock` 释放（`tests-ts/cli-e2e.test.ts:1294-1342`）。
- 控制台派生独立 CLI 进程、HTTP→CLI→checkpoint→completed 全链路（`tests-ts/cli-e2e.test.ts:1344-1415`）。
- 重复 `requestId` 服务重启后不重复派生（`tests-ts/observer.test.ts:1476-1561`）。
- 启动失败脱敏：`token=highly-secret` 在 500 响应与持久化 `launches/failed-request.json` 中均不出现、被替换为 `[REDACTED]`（`tests-ts/observer.test.ts:1563-1591`）。
- `/api/launch-options` 公开视图不泄漏 `executable`、`super-secret`（`tests-ts/observer.test.ts:1428-1473`）。

## 3. 逐条符合性判定（按整合报告分级）

### A. 发布阻断：暂停恢复闭环

- 不适用 — 本次 PR 不触碰 `src/core/structured.ts` / `src/core/discussion.ts` 的检查点状态机；`coordinatedStructuredCheckpoint` / `coordinatedDiscussionCheckpoint` 在 `src/cli/index.ts:324-416` 仍按既有逻辑运行；上一轮整合报告 `A` 项的 `pause -> resume` 风险未被新增代码触碰，也未被本次 PR 增量的 e2e 覆盖，建议保留为下一轮迭代。
- 判定：**维持，不上移**。

### B. 当前迭代必修：机器接口 / 中断 / 锁

| 子项 | 状态 | 证据 | 结论 |
| --- | --- | --- | --- |
| B1 JSON 失败路径 / 退出码 | 维持 | 本次 PR 新增 `--format json` 路径仍由 `writeCompletedResult` 统一处理（`src/cli/index.ts:603`、`tests-ts/cli-e2e.test.ts:1286` 在 `web-plan` 用例断言 JSON `status:"completed"`） | 当前实现行为未退化；契约形式化仍然欠缺，但属于本 PR 范围之外 |
| B2 `LOCKED` 退出码 / 锁回收 | 满足 | `src/cli/index.ts:557` / `src/cli/index.ts:735` 把 `mailbox` 提前到启动协调阶段仍在 `lock.acquire(id)`/`finally lock.release()` 包裹内；新增 e2e 验证取消后 `runtime/active.lock` 被释放（`tests-ts/cli-e2e.test.ts:1336-1338`） | 通过 |
| B3 项目只读门禁 | 满足 | `--web-plan` 路径下 `workspace` 透传进 `WebLaunchRequest` 与 `deliberate --workspace`，仍然走 `realpath` + `stat().isDirectory()`；`tests-ts/cli-e2e.test.ts:1344-1415` 只用 `structured` 文本议题验证 | 路径覆盖 |
| B4 敏感诊断脱敏 | 满足且增强 | `src/server/launch-coordinator.ts:152-156` 调用既有 `redactAdapterDiagnostic` 持久化失败原因；`src/server/observer.ts:189`、`observer.ts:198` 在 `/api/launch-options` 不可用预设的 `reason` 字段上调用同一脱敏；`tests-ts/observer.test.ts:1583-1588` 断言 `highly-secret` 既不在响应也不在持久化 `launches/*.json` | 通过；建议在 `observer.ts:189` 与 `observer.ts:198` 显式记录路径靠性依赖 `redactAdapterDiagnostic` 的全局依赖，可放入 `docs/审查报告/agy` D 类维护项 |
| B5 中断语义 | 满足 | `src/cli/index.ts:605-612`、`src/cli/index.ts:768-774` `catch` 块把 `state.status === "planning" || state.status === "waiting_checkpoint"` 都纳入了可中断归档，前一版本只判 `planning` 时 `waiting_checkpoint` 错误会被吞为 `failed`，本次修复与 e2e（`tests-ts/cli-e2e.test.ts:1336-1337`）闭环 | 通过 |

### C. 第二批：恢复 / 并发 / 观察服务防御性修复

| 子项 | 状态 | 证据 | 结论 |
| --- | --- | --- | --- |
| C1 控制台派生 CLI 进程进入活跃审议状态时与既有 `ActiveDeliberationLock` 的协同 | 部分 | 新增的 `LaunchCoordinator.activeDeliberationId()` / `pendingDeliberationId()` 读取 `runtime/active.lock`；但 `defaultProcessLauncher` 只 `spawn(... detached: true, stdio: 'ignore')` 并立刻 `unref()`，而 `ActiveDeliberationLock` 在子进程调用 `lock.acquire(id)` 时才创建 `active.lock`（`src/archive/store.ts:264+`）。在 `spawn` 与子进程 `acquire` 之间存在几百毫秒到几秒的窗口：如果另一个 `/api/launches` 请求在此窗口触发 `activeDeliberationId()`，会读不到 `active.lock`，进而 `pendingDeliberationId()` 命中前一次的 `spawned` 记录，**可能并发派生第二个审议进程**，违反 `src/core/types.ts:43` “同一应用数据根目录最多存在一个活动审议”与 ADR-0009 历史规定。当前 e2e（`tests-ts/observer.test.ts:1530-1538`）只覆盖了 `request-1` 已经建档后的冲突，未覆盖 spawn-async 窗口期间的二次尝试 | **P1** — 在 head 上不会让现有 e2e 失败，但需要在文档/ADR 中明示 “`LaunchCoordinator` 假定派生后立即进入规划；如需更强的并发阻断，应在 `defaultProcessLauncher` 内增加 per-launch 抢先 `active.lock` 探测或使用 `mad serve` 内置的 `LaunchCoordinator` 的 `pendingDeliberationId` 在建档前再次探测。建议如下一迭代处理 |
| C2 `pendingDeliberationId` 的归档已建档场景 | 满足 | `withArchiveStatus` 把 `planning`/`finished`/`failed` 三态区分（`launch-coordinator.ts:161-178`）；`pendingDeliberationId` 只取 `reserved`/`spawned`，前一个 launch 已进入 `planning`/`finished`/`failed` 时不会引发 `ActiveLaunchConflict`，符合 `mad` 单活动审议约束 | 通过 |
| C3 SSE 与客户端关闭 | 不适用 | 本次 PR 未改动 SSE | 维持 |
| C4 观察服务 401 响应 | 部分 | `src/server/observer.ts:173` 仍 `return send(response, 401, "Unauthorized")`，未注入 `WWW-Authenticate: Bearer realm="mad"`，但这已存在于 baseline，本 PR 未使其退化 | 维持 |
| C5 `PendingCheckpoint.data` 在 `events.jsonl` 中的暴露 | 满足 | `confirmPlan` 在 `setStatus("waiting_checkpoint")` 之后写 `appendEvent("checkpoint.pending", { kind, checkpointId, generation, candidateVersion })`（`src/cli/index.ts:261-266`），未把 `data.candidatePlan` 整段写入事件，避免了大段正文与可能含可识别角色描述的 `role` 进入审计流；同时网页 `replace` 校验失败时 `appendEvent("plan.validation_failed", { action, message })` 也只写入动作与错误消息（`src/cli/index.ts:300-302`） | 通过 |
| C6 `state.json` 深 schema 校验 | 部分 | `state.pendingCheckpoint` 当前 schema 仍只校验 `key/checkpointId/kind/summary/actions`（`src/archive/schema.ts:193-202`），不校验 `data`。控制台路径把 `candidateVersion` / `validationError` 放在 `pending.data` 中间传递，而 `setPendingCheckpoint`（`src/archive/store.ts:163-173`）不写 `data` 字段，所以落盘的 `state.pendingCheckpoint` 不会含 `data`；但 `request.json` 内确实携带 `data`，需要把它当作受信记录、只通过 `observer.ts:399-411` 的白名单字段校验；当前实现正确 | 维持 |
| C7 `schema_version` 常量化与时间戳 | 不适用 | 本 PR 未改动 | 维持 |

### D. 第三批：体验 / 校准 / 维护性

| 子项 | 状态 | 证据 | 结论 |
| --- | --- | --- | --- |
| D1 启动协调记录的脱敏 | 满足 | `launch-coordinator.ts:152-156`、`observer.ts:189`、`observer.ts:198`、`observer.ts:234` 在 4 个潜在泄漏点均调用 `redactAdapterDiagnostic`；e2e 在响应体与 `runtime/launches/*.json` 中验证无明文 token 残留 | 通过 |
| D2 议题与方案校对交互 | 满足 | `bindPlanEditor`（`src/web/index.ts`）只在 `validationError` 消失且 `confirmPlan` 的 `parseDeliberationPlan` + `preflightPlan` 重新走通后才允许 `confirm-plan` 按钮点用；`dirty()` 在每次输入把 `confirm.disabled = true`；e2e 在 `requires a version-bound web plan confirmation ...` 中走过 `replace` → 校验失败 → `validationError=/role/` 再校验通过 → `candidateVersion + 1` 的全路径 | 通过 |
| D3 重新组局的可逆性 | 满足 | `confirmPlan` 收到 `regroup` 时清理 `validationError`，新一次 proposal 同步 `version = 0`（`src/cli/index.ts:296`）；e2e 验证重新组局后 `candidateVersion` 回到 0（`tests-ts/cli-e2e.test.ts:1270`） | 通过 |
| D4 `report_agent_id` / `moderator_agent_id` 列表与参与者联动 | 满足 | `bindPlanEditor.refreshDutyOptions`（`src/web/index.ts`）在 `remove-agent` 后重建 `#report-agent` / `#moderator-agent` 的 `<option>`；先使用报告/主持 Agent 的参与者删除时返回提示而非真删除（`bindPlanEditor` 中的 `remove-agent` 守卫） | 通过；轻微的可用性提示文案已被现有 esc 转义覆盖 |
| D5 表单草稿与 `viewDirty` 拦截 | 满足 | `openLaunch` / `openArchive` / `beforeunload` 三个离开路径都阻止未保存草稿；同时 `confirmPlan` 服务端用 `candidateVersion` 阻止陈旧 `replace` | 通过 |
| D6 `archive.create` / `archive.writeManifest` 的 preflight 记录缺失 | 观察 | `replace` 路径在 `confirmPlan` 内对 `replacement` 调 `organizerService.preflightPlan`（`src/cli/index.ts:312`），但 `plan.candidate_replaced` 事件并未像 `plan.confirmed` 那样附加 `preflighted` 字段。可在下一迭代补齐与 `plan.confirmed` 一致的预检组合记录（`src/cli/index.ts:579` 已经记录 `proposed.preflightedCombinations`） | **P2** |
| D7 `defaultProcessLauncher` 复用当前进程 execArgv | 关注 | `defaultProcessLauncher` 直接复制 `process.execArgv` 与 `process.argv[1]`（`launch-coordinator.ts:50-79`）。当服务进程以 `--import tsx` 启动或被 tsx watch、vitest 等包装时（`tests-ts/cli-e2e.test.ts:1302-1304`、`tests-ts/cli-e2e.test.ts:1354-1356` 直接用 `process.execPath, ["--import","tsx", cli, ...]`），子进程会成为 `tsx` 运行的 `cli/index.ts`，并不会被打包成 `dist/cli/index.js`。在生产 `npm i` 后 `mad serve` 调用 `node_modules/.bin/mad` 的常见方式下，子进程依然可工作（`mad` 是 postbuild 后 `chmod 755 dist/cli/index.js` 的入口）。但若未来引入 `vitest` 调试模式或自定义运行包装（`pnpm exec node ...` 等），`process.argv[1]` 是相对路径且依赖当前 cwd，会令子进程解析失败 | **P2** — 建议在 `defaultProcessLauncher` 内把 `entry` 解析为绝对路径或要求服务进程显式传入 launch entry |
| D8 argv 边界 / 安全性 | 满足 | `defaultProcessLauncher` 只接受 `path` 模块、`process.execPath`、明确的若干参数；`topic` / `requestId` 等外部输入均通过 `worker`、`spawn` 形参传 `args: string[]`，不会因 shell 解析造成注入风险 | 通过 |

## 4. 阻断 / 警告 / 建议清单

> 严重度口径沿用 [`docs/审查报告/00-整合指导报告.md`](./../00-整合指导报告.md)：
> **P0**：发布阻断，已有可复现实路径；**P1**：建议在当前迭代合并前修正；**P2**：可顺延至下一迭代。

### P0

- 无。

### P1

1. **`LaunchCoordinator` 与 `ActiveDeliberationLock` 在派生窗口的协同存在并发风险**：`src/server/launch-coordinator.ts:104-159` 串行化 `launchExclusive`，但在 `defaultProcessLauncher` 内 `spawn(..., detached, unref)` 之后、`ActiveDeliberationLock.acquire` 之前的窗口期间，`runtime/active.lock` 仍未生成；该窗口期间另一并发 `/api/launches` 请求可能通过 `activeDeliberationId()`/ `pendingDeliberationId()` 检查并落到第二次 spawn。
   - 影响：当出现快速连续两次 `/api/launches` 调用且第一次仍处于 `reserved`/`spawned` 但子进程尚未 `acquire` 时，可能并发派生两个独立审议，违反 `src/core/types.ts:43` 与 ADR-0009 “同一 `MAD_HOME` 同时只允许一个活动审议”。
   - 最小修正建议：把派生窗口的互斥扩展到锁文件：可在 `launchExclusive` 创建 `runtime/launches/{requestId}.json` 后立即在 `runtime/active.lock` 写入占位 `{ deliberationId, pid: 0, pending: true }`（或单独 `runtime/launching.lock`），`pendingDeliberationId` 把占位 lock 视为活动，子进程 `ActiveDeliberationLock.acquire` 时覆盖 / 校验，避免并发派生；或要求 `defaultProcessLauncher` 在 `spawn` 之前先抢占 `active.lock`。

2. **`confirmPlan` 的 `replace` 与 `regroup` 事件缺少 `preflighted` 字段（观察项 D6）**：首版 `plan.confirmed` 事件已经写入 `preflighted: proposed.preflightedCombinations`（`src/cli/index.ts:579`），但 `plan.candidate_replaced` / `plan.regrouped` 事件不携带重新组合的 preflight 结果，使得审计仅能间接通过解析 `archive.appendDiagnostic` 推断新增/改变的调用组合是否预检通过。
   - 影响：档案可恢复性 / 审计细节缺口。
   - 最小修正建议：在 `src/cli/index.ts:297` 与 `src/cli/index.ts:316` 处把 `replace` / `regroup` 阶段的预检组合分别附在事件数据上，保持与首版 `plan.confirmed` 对齐；并补一条 e2e 断言事件字段。

3. **`defaultProcessLauncher` 假设 `process.argv[1]` 是绝对或工作目录相对可解析的可执行入口（观察项 D7）**：当 `mad serve` 被 `--import tsx`、`tsx watch`、`vitest run`、自定义包装运行时，子进程会沿用当前的 `--import tsx` 与 `process.argv[1]`，可能在不同 cwd 或 `npm pack` 后发生不可预期的解析失败。
   - 影响：未来引入观察服务在其它调试/包装形态下可能无法启动 CLI 进程；当前 `npm i` + `node_modules/.bin/mad` 路径不受影响。
   - 最小修正建议：将 `defaultProcessLauncher` 改为解析 `entry` 至绝对路径，或允许服务进程在 `startObserverServer(..., { launchDeliberation })` 中显式传入 `launchDeliberation` 默认实现，依赖调用方。

### P2

- `LaunchCoordinator.queue` 串行化在 `read()` 路径上有 `await atomicJson(...)`（`launch-coordinator.ts:114-116`），但 `pendingDeliberationId()`/`launchExclusive()` 走 `read()` 时仍会重写持久化文件；如果 read 频率增加会触发文件 IO。可在下一迭代调整为只在状态机推进时写回，避免轮询导致的覆盖抖动。
- `/api/launches/:requestId` 的 `404` 响应不带机器可读错误体（`observer.ts:230`），与 `/api/launches` 的 `409 JSON` 不一致；建议补 `{"code":"NOT_FOUND"}` 让前端可解析。
- `LaunchCoordinator.launchExclusive` 在 `planning` 之前的最长等待是 50 × 100ms = 5s，且 `withArchiveStatus` 在 `readFile(archive)` 出错 + `Date.now() - createdAt > 10_000` 才标记 `failed`（`launch-coordinator.ts:173-177`），与 5s 上限存在 5s 的状态机不一致——一旦 5s 后仍停留在 `spawned`，后续 `read()` 才会被 10s 后兜底。建议在同一处统一 5s / 10s。
- `pendingDeliberationId` 仅在 `reserved`/`spawned` 时返回；之前一次 `launch` 处于 `planning` 但 `active.lock` 仍未被派生进程拿到（例如对端 CLI 在打开 archive 之前挂起），当前实现会忽略，可能让第二次 launch 在 `pendingDeliberationId()` 返回 `null` 后通过 `activeDeliberationId()` 也返回 `null`，允许并发启动。建议在协调记录中追加 `pending` 状态。

## 5. 不属于本 PR 但建议下一轮处理

- `00-整合指导报告.md` A 项的 `pause -> resume` 闭环未被本 PR e2e 覆盖（仅 `tests-ts/cli-e2e.test.ts:1417` 为基准基线用例），建议延续作为下一迭代的发布阻断项。
- `00-整合指导报告.md` C 项 SSE `WWW-Authenticate` 未在本 PR 内补齐。

## 6. 整体结论

| 维度 | 判定 |
| --- | --- |
| 与目标架构 / 既有约束的一致性 | 维持并强化 — 派生子进程而非嵌入服务进程、不直接写正式档案、CLI 注册表安全视图、循环脱敏 |
| 持久化与幂等性 | 已覆盖 — 启动协调记录 + 重复 `requestId` 不重复派生、失败/重启均通过原子 JSON |
| 测试覆盖 | 充分 — 113/113 通过，新增 6 个测试覆盖版本绑定检查点、取消 / 锁释放、独立进程派生与脱敏 |
| 文档同步 | 同步 — `CONTEXT.md`、`README.md`、`docs/adr/0018*.md`、`TypeScript 目标架构` 已随 PR 增量更新，但当前 PR 没把目标架构与实现验收文档同步调整（保留为维护项） |

综合判定：**整体可合入，但应在合并前至少落实 P1-1（并发派生窗口的占位锁）与 P1-3（`entry` 绝对路径解析）这两条防御性修订，否则并发退化到双活动审议或某类包装形态启动失败的风险会被带入 `v0.2.0-dev.5`。P1-2（事件 `preflighted` 字段）是审计细节，可在合并后立刻跟单独立项补齐。**

> **审查 head SHA：`5ec1ac2296c01dcf2d4fe72d6f8ee352f7ee909d`（`codex/deliberation-console-launch`）**

> 审查人：Claude Code · 模型：claude-opus-4-8[1m]


---

**变更时间**：2026-07-23
**变更概要**：完成 PR#28（head SHA `5ec1ac2`，分支 `codex/deliberation-console-launch`）独立审查；围绕 `LaunchCoordinator` + `plan_confirmation` 版本绑定检查点 + 控制台三步向导 + 独立 CLI 派生，覆盖 A/B/C/D 分级；给出 P1 偏差 3 项（并发派生窗口未与 `ActiveDeliberationLock` 协同、replace/regroup 事件缺少 `preflighted` 字段、`defaultProcessLauncher` 对 `process.argv[1]` 的可解析性依赖）与 P2 偏差 4 项（轮询重写协调记录、`/api/launches/:requestId` 404 不带 JSON 体、5s/10s 状态机不一致、pending 状态缺失）；验证命令 `npm run typecheck`、`npm run build`、`npx vitest run`（113/113 通过）、`git diff --check` 在 head 上全部通过；判定未发现 P0 阻断级缺陷，但建议合并前至少落实 P1-1（占位锁）与 P1-3（绝对路径解析）这两条防御性修订。
