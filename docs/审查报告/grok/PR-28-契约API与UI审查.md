# PR #28 契约 / API / UI 审查报告

| 项 | 内容 |
|----|------|
| PR | #28 `feat: 在审议控制台中发起并配置审议` |
| Head SHA | `5ec1ac2296c01dcf2d4fe72d6f8ee352f7ee909d` |
| 分支 | `codex/deliberation-console-launch` → `main` |
| 审查范围 | HTTP 启动/选项/方案检查点契约、页面三步向导与草稿、安全公开视图、schema/types 档案兼容、README/CONTEXT/ADR 一致性、领域术语 |
| 方法 | 读 PR 描述与 `main...head` diff；CodeGraph + 定点读 `observer` / `launch-coordinator` / `web` / `schema` / `types` / 测试与文档 |
| 约束 | 不改业务代码；不发 GitHub review |

---

## Verdict

**有条件通过（Conditional Pass）**

主链路契约整体成立：Bearer + loopback、安全公开发起选项、`requestId` 幂等启动协调、方案检查点 `candidateVersion` 绑定、档案 `planning.candidateVersion` 可选增量字段、三步向导与标签页草稿方向正确，且有 observer/e2e 测试覆盖。
合并前建议至少处理 **F1（错误体解析）** 与 **F2（canLaunch 与 pending 启动不一致）**；其余为体验与文档一致性问题，可跟进修复。

---

## 符合项摘要

| 维度 | 结论 |
|------|------|
| 新 HTTP 端点鉴权 | `/api/*` 统一 Bearer；静态资源无鉴权；与既有观察 API 一致 |
| 启动幂等 | 同 `requestId` 直接返回已有 `LaunchRecord`（200），不重复 spawn；重启后可读 `runtime/launches/*.json` |
| 启动状态码 | `planning→201` / 中间态→`202` / `failed→500`；冲突 `409` + `ACTIVE_DELIBERATION` |
| 方案版本绑定 | `plan_confirmation` 强制 `candidateVersion` 与 pending 一致，否则 409；e2e 覆盖 stale/replace/regroup/cancel |
| 安全公开视图 | `PublicLaunchCli` 仅 `id/model/contextBudget/options/available/reason`，不含 `executable`；失败 reason 经 `redactAdapterDiagnostic`；测试断言路径与密钥不出现在响应 |
| 档案兼容 | `planning.candidateVersion?: number` 可选；`schema_version` 仍为 1；旧档案无该字段可解析 |
| 架构边界 | 控制服务写启动协调记录与信箱响应；正式档案由独立 `deliberate --web-plan` 进程写入（ADR-0018 / README 一致） |
| UI 主路径 | 三步向导（议题→生成方案→配置 Agent）、sessionStorage 草稿、`viewDirty` + `beforeunload`、活动审议跳转、工作目录授权提示、`@media(max-width:760px)` 步骤条、`aria-live`/`role=status`/`role=alert` 部分就位 |
| 方案编辑载荷 | 前端 `collectPlan` 使用 external snake_case（`report_agent_id` 等），与 `externalPlan` / `parseDeliberationPlan` 对齐 |
| 文档主叙事 | README「审议控制台」、CONTEXT「审议议题/审议控制台」、ADR-0018 与实现方向一致 |

---

## Findings

### F1 · 中 · 非 2xx JSON 错误体被当作纯文本展示

**位置**

- `/Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts:24`（`api()`）
- `/Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts:255-255`、`306-309`、`313-314`

**问题**

`api()` 在 `!response.ok` 时 `throw new Error(await response.text())`。
以下响应均为 JSON，却会把整段 JSON 塞进「发起失败：…」：

- `409` `{"code":"ACTIVE_DELIBERATION","activeDeliberation":{"id":"..."}}`
- `500` 失败 `LaunchRecord`（含 `error` 字段，虽已脱敏）

首次 spawn 失败走 500，**不会**进入 `record.status==='failed'` 的友好分支（该分支仅在 2xx 且 body 可 parse 时生效）。

**可操作修复**

1. `api()`：若 `Content-Type` 含 `application/json`，解析后优先取 `error` / `message` / `code` 生成人类可读文案；`ACTIVE_DELIBERATION` 时提示并触发跳转活动审议。
2. 或统一错误 envelope：`{ "code", "message", ... }`，成功与失败都用稳定字段。
3. 启动失败也可考虑 `200/201` + `status:"failed"`（若希望客户端总走 JSON 业务分支）；若保留 500，前端必须解析 body。

---

### F2 · 中 · `canLaunch` / `activeDeliberation` 未计入 pending 启动协调态

**位置**

- `/Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts:141-152`（`activeDeliberation` 仅读 `active.lock`）
- `/Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts:206-220`（`canLaunch: active === null`）
- `/Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts:253-256`（POST 冲突预检同样只看 lock）
- `/Users/libo/Documents/github/Multi-agent-decision-making/src/server/launch-coordinator.ts:128-129`、`198-209`（`pendingDeliberationId` 会拦截 `reserved`/`spawned`）

**问题**

契约表面：`GET /api/launch-options` 的 `canLaunch===true` 表示可发起。
实际：另一请求已 `reserved/spawned` 但尚未写入/持有有效 `active.lock` 时，UI 仍显示可发起；POST 可能在 coordinator 层 409，或先过 observer 预检再 409。
活动审议按钮也依赖 `activeDeliberation`，pending 阶段无法「查看当前活动审议」。

**可操作修复**

1. 将「活动或 pending 启动」统一封装（复用 `LaunchCoordinator` 的 active/pending 逻辑）。
2. `launch-options` 与 POST 预检使用同一判定：`canLaunch=false`，并返回 `activeDeliberation: { id }`（即便档案尚未可读，也应返回协调记录中的 `deliberationId`）。
3. 补测试：无 `active.lock`、仅有 `runtime/launches/*.json` 为 `spawned` 时 `canLaunch===false`。

---

### F3 · 中 · 方案校验失败后状态文案自相矛盾

**位置**

- `/Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts:34`（`planEditor`）
- 后端语义：`/Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts:305-320`（replace 失败保留上一版有效方案，只写 `validationError`）

**问题**

存在 `validationError` 时仍渲染：

- `role="alert"` 展示失败原因
- `#plan-validation` 固定「当前候选方案已通过校验。」
- `#confirm-plan` 仍可点（后端会确认**上一版有效方案**，逻辑正确但 UI 误导）

**可操作修复**

1. 有 `validationError` 时：`#plan-validation` 改为说明「上一版候选方案仍有效；本次修改未通过校验」，或清空成功文案。
2. 可选：在 alert 旁提供「确认上一版并开始」与「继续编辑」的明确区分。
3. 勿在失败态同时宣称「已通过校验」。

---

### F4 · 低–中 · 启动轮询无超时 / 无取消 / 无导航保护

**位置**

- `/Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts:28`（`startLaunch` 内 `while(true)` + 500ms）

**问题**

依赖后端 `withArchiveStatus` 约 10s 将卡死 spawn 标为 failed。前端无最大尝试次数、无 Abort、离开向导后轮询仍可能 `openArchive` 抢焦点。

**可操作修复**

1. 轮询上限（例如 60–120 次）超时后展示可重试错误。
2. 用 `AbortController` 或 `let launchGeneration` 在 `openLaunch`/`openArchive` 时作废旧轮询。
3. 状态文案区分 `reserved`/`spawned`/`planning`。

---

### F5 · 低 · 脏编辑在同档案重入时被静默丢弃

**位置**

- `/Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts:42`（包装后的 `openArchive`）

**问题**

```js
if (viewDirty && id !== selected && !confirm(...)) return;
viewDirty = false;
```

同 `id` 重入（SSE `checkpoint.*` / `deliberation.*`）不弹确认，直接清 `viewDirty` 并重绘，可能丢掉未提交方案编辑。

**可操作修复**

1. 同 id 且 `viewDirty`：跳过自动重绘，或合并仅更新非编辑区。
2. 或自动重绘前 `confirm`，取消则保留 DOM。

---

### F6 · 低 · 错误/状态码语义不统一（契约完整度）

**位置**

- `/Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts` 多处 `send(response, 4xx/5xx, plain text)` vs JSON
- 同文件 `434`：通用 catch 500 返回 `error.message`（未必脱敏）
- 同文件 `442`：文案仍为「无法确定**观察服务**端口」

**问题**

400/404/409（部分）为 `text/plain`，409 冲突与 500 启动失败为 JSON；客户端难以统一处理。通用 500 与启动路径脱敏策略不一致。

**可操作修复**

1. API 错误统一 JSON：`{ code, message }`。
2. 对外 message 经 `redactAdapterDiagnostic`。
3. 术语改为「审议控制台」。

---

### F7 · 低 · 文档与术语残留

| 位置 | 问题 | 建议 |
|------|------|------|
| `README.md` 测试/覆盖描述（约「观察服务认证」一句） | 主章节已改为审议控制台，测试段仍写观察服务 | 统一为审议控制台 / 控制台认证 |
| `src/server/observer.ts:442` | 「观察服务」 | 「审议控制台」 |
| `src/web/index.ts` 步骤 3「配置 Agent」 | CONTEXT 规范术语为「审议 Agent」 | 改为「配置审议 Agent」 |
| `src/cli/index.ts` usage「问题」 | 领域词已改为审议议题 | usage/帮助文案逐步改为议题（档案字段 `question` 可保留兼容） |
| `docs/TypeScript实现与验收.md` 等（非本 PR 必改） | 仍大量「观察服务」 | 后续文档迭代 |

ADR-0018 单段陈述与实现一致，可接受；若仓库 ADR 惯例需要「状态/后果」小节，可后续补全，不阻合并。

---

### F8 · 信息 · `WEB_ASSET_VERSION` 未递增

**位置**

- `/Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts:1`（仍为 `1`）

**问题**

页面资产大改但版本常量未变；当前未见 cache-bust 引用，暂无运行时影响。

**建议**

若该常量用于缓存协议，随 UI 变更递增；否则删除或在注释中标明用途，避免死契约。

---

### F9 · 信息 · 档案 schema 变更评估（无破坏）

**位置**

- `/Users/libo/Documents/github/Multi-agent-decision-making/src/core/types.ts:85`
- `/Users/libo/Documents/github/Multi-agent-decision-making/src/archive/schema.ts:170-172`

**结论**

`planning.candidateVersion` 为**可选**整型（`>=0`），`schema_version` 保持 `1`。
旧档案、无 planning、或无 candidateVersion 的 planning 均可解析；新写入在组局循环中维护版本。
**不构成档案破坏性变更。**

---

### F10 · 信息 · 安全公开视图与后端一致（通过）

| 字段 | 公开 | 说明 |
|------|------|------|
| `executable` / 路径 | 否 | 未进入 `PublicLaunchCli` |
| adapter 内部诊断 | 否 | `reason` 脱敏 |
| `options` | 是 | 仅配置允许的 effort/thinking 等，非凭证 |
| `model` / `contextBudget` | 是 | 选择所需 |
| 档案详情 `registrySnapshot` | 仍含 executable | 属已认证本地档案视图，非 launch-options；与「发起选项安全公开」主张不冲突 |

测试：`tests-ts/observer.test.ts` 覆盖 launch-options 脱敏与 401。

---

## Verification（审查侧核对，非重新跑全量 CI）

| 项 | 结果 |
|----|------|
| PR 描述 vs 实现 | 三步向导、幂等启动、版本绑定信箱、安全选项、术语/ADR/README 均有对应代码 |
| `GET /api/launch-options` | 结构完整：`defaults` / `limitRange` / `clis` / `activeDeliberation` / `canLaunch`；**pending 缺口见 F2** |
| `POST/GET /api/launches` | 字段白名单、topic/mode/interaction/limits/organizer 校验、幂等、冲突码存在；错误展示见 F1 |
| `POST .../respond` + plan actions | `confirm/replace/regroup/cancel` + `candidateVersion`；与 CLI `confirmPlan` 一致 |
| UI 草稿 | `sessionStorage` key `mad-launch-draft`；FormData 往返；提交成功后清除 |
| 活动审议跳转 | `active-deliberation` 按钮 + `openArchive(id)`；依赖 lock，见 F2 |
| 响应式/语义 | 步骤条 media query；`aria-live`/`aria-current`/`role=status|alert` 部分具备；F3 文案冲突削弱状态可信度 |
| schema/types | 可选字段，兼容 |
| 测试 | observer：安全选项、幂等、失败脱敏；cli-e2e：web-plan 版本绑定与控制台 HTTP→独立进程路径 |

建议合并前本地再跑：`npm run typecheck && npm test`（PR 描述称 113 passed）。

---

## Residual Risk

1. **多标签并发发起**：即使修 F2，极端并发仍应靠 coordinator 队列 + 409；前端需友好处理（F1）。
2. **workspace 路径**：API 仅长度校验，真实 `realpath`/目录检查在审议进程；错误路径表现为启动后 failed，而非 400。
3. **通用 500 未脱敏**：非启动路径异常可能回传原始 `error.message`。
4. **浏览器交互**：PR 声明未做手工浏览器检查；脏编辑/SSE 重绘（F5）、轮询（F4）、校验失败文案（F3）需人工点验。
5. **历史文档**（目标架构/验收）仍写「观察页不能发起」类旧边界，可能与 ADR-0018 并存造成读者困惑，属文档债。

---

## 建议合并门槛

| 优先级 | 项 |
|--------|----|
| 建议合并前 | F1 错误解析或统一错误 envelope；F2 `canLaunch`/pending 对齐 |
| 可紧随 PR | F3 校验失败文案；F4 轮询超时；F6/F7 术语与错误 JSON 化 |
| 不阻塞 | F5、F8、历史文档债 |

---

**变更时间**：2026-07-23
**本次变更概要**：新增 PR #28 契约/API/UI 审查报告（Verdict、Findings F1–F10、Verification、Residual Risk）。

---

Agent: grok-subagent-contract-ui · Model: Grok · 时间 2026-07-23
