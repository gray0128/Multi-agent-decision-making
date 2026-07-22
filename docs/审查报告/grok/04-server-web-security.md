# 审查报告：观察服务 / 检查点 / Web / 本地认证 / 工作目录安全

**审查员**：Grok Build（独立对照）  
**对照基准**：`docs/TypeScript目标架构.md` 第 10、11、12、15 节，以及第 1 节观察/安全相关约束  
**忽略**：其他审查报告意见  
**审查对象工作区**：`/Users/libo/Documents/github/Multi-agent-decision-making`

---

## 1. 范围与方法

### 1.1 范围

| 架构节 | 关注点 |
|--------|--------|
| §10 检查点动作 | continue / guide / end（仅 free）/ pause / cancel；首次 Ctrl-C=暂停并终止子进程；终端与观察页首份有效响应获胜；过期/重复/ID 不匹配拒绝 |
| §11 观察服务与页面 | `mad serve` 独立；审议不依赖服务；文件信箱；静态 HTML/CSS + 原生 TS；Markdown 净化；流式仅状态事件、正文整体显示 |
| §12 本地认证 | 每次启动新 Bearer；URL fragment；sessionStorage；API Bearer；不绑 query/Cookie/磁盘；仅 `127.0.0.1` |
| §15 工作目录与安全 | 纯文本无工作目录；项目须 `--workspace`；直接只读规范化；stderr 风险提示；档案记录路径与模式；适配器只读验证；无快照排密 |
| §1 约束补充 | 页面不能发起/恢复/删除审议或改 CLI 注册表；审议进程为档案唯一写入者；本地仅 `127.0.0.1` |

### 1.2 方法

- **必读源码**：`src/server/*`、`src/web/*`、`src/adapters/read-only.ts` 及 codex/generic 只读标志、`src/core` 中 checkpoint/mailbox 交互（`execution` / `structured` / `discussion` / CLI 协调层）、`src/cli/index.ts` 相关路径。
- **必读测试**：`tests-ts/mailbox.test.ts`、`observer.test.ts`、`markdown.test.ts`、`read-only.test.ts`、`interrupt.test.ts`。
- **对照方式**：逐条映射架构条款到实现与测试；不引入其他报告结论。
- **工具**：CodeGraph 定位符号与调用链，辅以定点读文件与 grep。

### 1.3 关键路径（绝对路径）

| 区域 | 路径 |
|------|------|
| 观察服务 | `/Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts` |
| 文件信箱 | `/Users/libo/Documents/github/Multi-agent-decision-making/src/server/mailbox.ts` |
| 绑定常量 | `/Users/libo/Documents/github/Multi-agent-decision-making/src/server/constants.ts` |
| 页面资产 | `/Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts` |
| Markdown | `/Users/libo/Documents/github/Multi-agent-decision-making/src/web/markdown.ts` |
| 只读 canary | `/Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/read-only.ts` |
| 适配器 | `/Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/codex.ts`、`generic.ts`、`process.ts` |
| 检查点协调 | `/Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts` |
| 控制器 | `/Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts`、`discussion.ts`、`planning.ts`、`execution.ts` |

---

## 2. 符合项

### 2.1 §10 检查点动作

| 条款 | 实现证据 | 判定 |
|------|----------|------|
| **继续** | 结构化/自由讨论 pending actions 均含 `continue`；终端回车映射为 `continue` | 符合 |
| **指导后继续** | actions 含 `guide`；`/guide …` 或页面 guidance + `guide`；决策侧映射为 `continue` 并写入 guidance | 符合 |
| **结束讨论（仅 free）** | 仅 `coordinatedDiscussionCheckpoint` 提供 `end`；结构化 actions 无 `end`；`DiscussionController.atBoundary` 处理 `end` 进入报告流水线 | 符合 |
| **暂停** | `pause` → `MadError("PAUSED")` → `setStatus("paused")` | 符合 |
| **取消** | `cancel` → `MadError("CANCELLED")` → `setStatus("cancelled")`；档案保留 | 符合 |
| **首次 Ctrl-C = 暂停 + 终止子进程** | `process.once("SIGINT", () => interrupt.abort())`；`runProcess` 在 abort 时对进程组 `SIGTERM`/`SIGKILL`；检查点等待时 abort 向信箱 `submit(..., "pause")`；调用中抛 `PAUSED` | 符合 |
| **首份有效响应获胜** | `publishExclusiveJson` 用 `link` 独占创建；第二写返回 `false` / HTTP 409；测试 `rejects a second claimant` | 符合 |
| **过期/重复/ID 不匹配拒绝** | 新检查点默认删除旧 response；消费端要求 `checkpointId` 匹配且 action ∈ pending.actions；观察服务 409 `Stale or invalid`；重复 409 `already answered` | 符合 |

检查点动作协调（摘录）：

```273:307:/Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts
    const pending = { kind: stage, summary, actions: ["continue", "guide", "pause", "cancel"] } as const;
    // ...
          if (answer === "/pause") return { action: "pause" };
          if (answer === "/cancel") return { action: "cancel" };
          if (answer.startsWith("/guide")) return { action: "guide", guidance: answer.slice(6).trim() };
    // ...
    const decision = {
      action: response.action === "guide" ? "continue" as const : response.action as "continue" | "pause" | "cancel",
      ...(response.guidance ? { guidance: response.guidance } : {}),
    };
```

自由讨论额外动作：

```321:333:/Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts
    const pending = { kind, summary: rationale, actions: ["continue", "guide", "end", "pause", "cancel"] } as const;
    // ...
          if (["/end", "/pause", "/cancel"].includes(answer)) return { action: answer.slice(1) };
```

### 2.2 §11 观察服务与页面

| 条款 | 实现证据 | 判定 |
|------|----------|------|
| **`mad serve` 独立长期进程** | `serve()` 启动 `startObserverServer`，SIGINT/SIGTERM 才关闭 | 符合 |
| **审议不依赖观察服务** | guided 可用终端；auto 不注册 checkpoint；服务 offline 时 guided 仅需终端；`observerIsOnline` 仅用于通道探测 | 符合 |
| **服务重启不中断审议** | 通信仅为 runtime 文件；无长连接 RPC 依赖 | 符合 |
| **文件信箱在 `MAD_HOME/runtime`** | `join(runtime, "checkpoints", …)`；目录 `0o700`、文件 `0o600` | 符合 |
| **审议原子发布检查点** | request 经 tmp + `rename`；并 `setPendingCheckpoint` / `checkpoint.pending` 事件 | 符合 |
| **服务只写一次性响应** | 仅 `publishExclusiveJson` 写 `*.response.json`；无档案写路径 | 符合 |
| **审议校验并消费** | 匹配后 `onAccepted` 持久化决策，再删 request/response | 符合 |
| **服务不能改档案** | API：列表/详情/SSE 只读；唯一 POST 为 checkpoint respond → runtime 响应文件 | 符合 |
| **静态 HTML/CSS + 少量原生 TS** | `INDEX_HTML` / `STYLES_CSS` / `APP_JS` 字符串；无前端框架依赖（package.json 仅 marked/sanitize-html 服务端） | 符合 |
| **Markdown 独立解析与净化** | `marked` + `sanitize-html`；禁 script/onerror/javascript:；测试覆盖 | 符合 |
| **流式仅状态事件** | SSE 读 `events.jsonl`（阶段/调用/检查点等）；无 token 流 | 符合 |
| **正文调用完成后整体显示** | 页面在 `invocation.committed` 后 `refreshTranscript`；`contentHtml` 来自已提交 transcript | 符合 |
| **无 thinking / 原始 stdout 给浏览器** | 事件不含 stdout/stderr；`diagnostics.jsonl` 不暴露 API；transcript 为规范化公开文本 | 符合 |
| **页面不能发起/恢复/删除审议或改注册表** | 无对应写 API；仅检查点响应 | 符合 |

信箱消费与独占写：

```22:33:/Users/libo/Documents/github/Multi-agent-decision-making/src/server/mailbox.ts
export async function publishExclusiveJson(path: string, value: unknown): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
```

观察服务写权限边界：

```168:201:/Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts
      const respondMatch = /^\/api\/checkpoints\/([^/]+)\/respond$/.exec(url.pathname);
      if (request.method === "POST" && respondMatch) {
        // ... 校验 checkpointId / action / guidance ...
        if (!await publishExclusiveJson(responsePath, {
          checkpointId: payload.checkpointId,
          action: payload.action,
          guidance,
          at: new Date().toISOString(),
        })) return send(response, 409, "Checkpoint already answered");
```

页面流式与权威正文：

```31:31:/Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts
// stream: 展示 event.type 与结构化字段；invocation.committed → refreshTranscript；无 token 级拼接
```

### 2.3 §12 本地认证

| 条款 | 实现证据 | 判定 |
|------|----------|------|
| **每次启动新 Bearer** | `randomBytes(32).toString("base64url")` 于 `startObserverServer` | 符合 |
| **URL fragment 交给页面** | `url: http://127.0.0.1:${port}/#token=...`；stderr 打印 | 符合 |
| **读后移除，仅 sessionStorage** | `APP_JS`：`sessionStorage.setItem` + `history.replaceState` 去掉 hash | 符合 |
| **API 使用 Authorization Bearer** | `authorized()` 解析 Bearer；列表/详情/SSE/respond 均在 `/api/` 后强制校验；`timingSafeEqual` | 符合 |
| **Token 不进 query / Cookie / 磁盘** | 无 Cookie 逻辑；query 无 token；`server.json` 仅 pid/port/startedAt；测试 `heartbeat.not.toContain(token)` | 符合 |
| **只绑 127.0.0.1** | `SERVER_HOST = "127.0.0.1"`；`server.listen(port, SERVER_HOST)` | 符合 |

```113:120:/Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts
  const token = randomBytes(32).toString("base64url");
  // ...
      if (!url.pathname.startsWith("/api/") || !authorized(request, token)) return send(response, 401, "Unauthorized");
```

```222:222:/Users/libo/Documents/github/Multi-agent-decision-making/src/server/observer.ts
    url: `http://${SERVER_HOST}:${address.port}/#token=${encodeURIComponent(token)}`,
```

### 2.4 §15 工作目录与安全

| 条款 | 实现证据 | 判定 |
|------|----------|------|
| **纯文本无工作目录** | 无 `--workspace` 时用 `runtime/scratch/<id>` 私有空目录；manifest 无 `workspace` | 符合 |
| **项目必须 `--workspace`** | 选项仅 `workspace`；无 `--direct-workspace`；`realpath` + 目录校验 | 符合 |
| **直接只读规范化原始目录** | `cwd = await realpath(...)`；`mode: "direct-read-only"` 写入 manifest | 符合 |
| **stderr 风险提示** | `参与 CLI 已获完整目录只读授权：${path}` 经 `emitWarnings` → stderr + 档案 warning 事件 | 符合 |
| **绝对路径与读取模式写档案** | `workspace: { path, mode: "direct-read-only" }` | 符合 |
| **适配器启用只读并验证** | Codex：`--sandbox read-only`；Claude/Grok：`plan` + 工具白名单；Pi：只读 tools；agy：`--mode plan --sandbox`；reasonix：`projectReadOnlyCapability = "unsupported"` 项目模式拒绝；`verifyReadOnlyWithCanary` 运行时 canary | 符合 |
| **不满足不能用于项目审议** | `requireProjectReadOnly` 失败抛 `PREFLIGHT`；组局器与参与者预检均覆盖 | 符合 |
| **不通过快照排除秘密** | 无材料快照/秘密排除路径；提示“完整目录只读授权” | 符合 |
| **不隐式使用当前目录作项目根** | 项目根仅来自显式 `--workspace` | 符合 |

```408:414:/Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts
  let workspace: { path: string; mode: "direct-read-only" } | undefined;
  if (parsed.values.workspace) {
    cwd = await realpath(parsed.values.workspace);
    if (!(await stat(cwd)).isDirectory()) throw new MadError("USAGE", `工作目录不是目录：${cwd}`);
    workspace = { path: cwd, mode: "direct-read-only" };
  }
  const workspaceWarnings = workspace ? [`参与 CLI 已获完整目录只读授权：${workspace.path}`] : [];
```

```209:217:/Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts
  private async requireProjectReadOnly(adapter: CliAdapter, label: string, signal?: AbortSignal): Promise<void> {
    if (adapter.projectReadOnlyCapability === "unsupported") {
      throw new MadError("PREFLIGHT", `${label} 未证明支持最低只读约束，禁止项目模式`);
    }
    const result = await adapter.verifyProjectReadOnly(signal);
    // ...
    if (!result.verified) {
      throw new MadError("PREFLIGHT", `${label} 项目只读验证失败：${result.detail ?? "证据不足"}`);
    }
```

### 2.5 测试覆盖（与本节相关）

| 测试文件 | 覆盖 |
|----------|------|
| `mailbox.test.ts` | 首有效响应、第二竞争者失败、恢复复用 checkpointId、决策持久化失败保留文件 |
| `observer.test.ts` | 127.0.0.1、401 无 token、检查点一次接受/重复 409、报告 HTML 去 script、heartbeat 无 token、online 探测 |
| `markdown.test.ts` | 结构渲染 + 可执行 HTML/危险协议剥离 |
| `read-only.test.ts` | canary 通过/写入成功失败/nonce 未读失败 |
| `interrupt.test.ts` | abort 中止活动调用并保留冻结逻辑调用 |

---

## 3. 偏差

以下为相对目标架构的残余差距或薄弱点（非“完全未实现”）。

### 3.1 [低] 非法独占响应可卡死等待（信箱消费侧）

**架构**：过期、重复或 ID 不匹配的响应应被拒绝。  
**现状**：消费循环对 ID/action 不匹配会忽略并继续轮询；但 `response.json` 一旦被独占创建，合法后写无法覆盖。  
**正常路径**：观察服务在写入前校验 `checkpointId` 与 `actions`；终端仅提交合法动作，故常见场景安全。  
**边界**：同一用户下恶意/损坏的 `*.response.json`（错误 `checkpointId`）可导致检查点永久等待。  
**位置**：`src/server/mailbox.ts` `wait()` / `publishExclusiveJson`。

### 3.2 [低] `mailbox.submit` 自身不校验 action 集合

**架构**：无效响应应拒绝。  
**现状**：校验集中在观察服务 POST 与终端输入解析；`CheckpointMailbox.submit` 只做独占写。  
**影响**：防御纵深略薄；终端与页面正常路径仍正确。  
**位置**：`src/server/mailbox.ts` `submit`。

### 3.3 [信息] `guide` 与“继续附带 guidance”并存

**架构**：单独动作「指导后继续」。  
**现状**：显式 `guide`，且页面在任意动作（含 `continue`）时都会提交 guidance 字段；非空 guidance 均会记入档案。  
**判定**：功能覆盖完整；命名上是实现细化，不构成行为违背。

### 3.4 [信息] SSE 响应头未复用 `send()` 的 CSP 等头

**现状**：普通 API 有 CSP/`nosniff`/`no-store`；SSE 分支仅设置 `text/event-stream` 相关头。  
**判定**：不违背 §11/§12 功能条款；属加固机会。

### 3.5 [信息] 静态资源无需认证

**现状**：`/`、`/styles.css`、`/app.js` 公开；敏感数据均在 `/api/*`。  
**判定**：与 fragment 引导页模型一致，符合“Token 交给页面后由 API 认证”的设计，不记为违背。

---

## 4. 风险与建议

| 优先级 | 建议 | 理由 |
|--------|------|------|
| P2 | 消费侧若读到**存在但无效**的 response（ID/action 不符），删除或隔离该文件并继续等待；或 `submit` 写入前强制对照当前 request | 消除非法独占导致的 guided 卡死 |
| P3 | `CheckpointMailbox.submit` 读取当前 request，校验 `checkpointId` + `actions` 后再独占写 | 与观察服务校验对齐，纵深防御 |
| P3 | SSE 响应补齐 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`（及合理 CSP） | 与 `send()` 安全头一致 |
| P3 | 为“错误 checkpointId 响应不阻断后续合法响应”增加 mailbox 回归测试 | 锁死 §10 拒绝语义边界 |
| P4 | 页面 `guide` 空 guidance 时提示或降级为 `continue` | UX，非架构硬性要求 |

**已做得好的安全面（保持）**：

- 档案唯一写入者 = 审议进程；观察服务只读档案 + 信箱响应。
- Bearer 仅内存 + fragment + sessionStorage；`server.json` 无 token。
- 固定 `127.0.0.1`；Markdown 服务端净化后再下发 HTML。
- 项目模式 canary + 适配器硬编码只读/plan 参数，配置 schema 无安全参数覆盖字段。
- 子进程 `detached` 进程组终止，满足 Ctrl-C 停 CLI。

---

## 5. 评分

评分维度仅针对本次对照的 §10 / §11 / §12 / §15 / §1 相关约束（10 分制）。

| 维度 | 分数 | 说明 |
|------|------|------|
| §10 检查点动作与竞态 | **9.0** | 五类动作、首响应获胜、ID/重复拒绝、SIGINT→暂停+杀子进程均落地；非法 response 卡死为边角 |
| §11 观察服务与页面 | **9.2** | 进程分离、信箱、只读档案、静态原生页、净化 Markdown、状态 SSE + 提交后正文均符合 |
| §12 本地认证 | **9.5** | Token 生命周期与绑定模型完整；测试覆盖 401/无磁盘 token/本机绑定 |
| §15 工作目录与安全 | **9.0** | 显式 workspace、直接只读、档案字段、预检/canary、无快照排密；依赖各 CLI 运行时行为的残余风险属模型固有 |
| §1 页面能力边界 | **9.5** | 无可发起/恢复/删除审议或改注册表的 API |
| **综合** | **9.2** | 核心架构约束已实现；残余为边角硬化与测试补强 |

### 结论

TypeScript 实现在**检查点协调、文件信箱、观察服务权限边界、本地 Bearer 认证、项目只读工作目录**上与目标架构第 10–12、15 节及第 1 节相关约束**高度一致**。未发现“页面可改档案/注册表”“Token 落盘或 query”“监听非本机”“token 级正文流”“隐式当前目录项目授权”等硬性违背。建议优先处理信箱在非法独占响应下的卡死边角，以完全闭合 §10「无效响应拒绝」的运营语义。

---

## 变更记录

- **2026-07-22**：初稿。对照 `TypeScript目标架构.md` §10/11/12/15 与 §1 观察/安全约束，审查 `src/server`、`src/web`、只读适配器、检查点协调与相关 tests-ts；输出符合项、偏差、风险建议与评分。
