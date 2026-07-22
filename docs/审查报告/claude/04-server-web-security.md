# 分册 #4：观察服务 / 检查点 / 安全 审查报告

> 审查范围：`src/server/**`、`src/web/**`、`src/adapters/{read-only,redact,public-text}.ts`、与之相关的 `src/cli/index.ts` 与 `src/archive/store.ts`
> 参考条款：`docs/TypeScript目标架构.md` §10 检查点动作、§11 观察服务与页面、§12 本地认证、§15 工作目录与安全
> 审查时间：2026-07-22

---

## 1. 对照章节与文件映射

| 目标架构章节 | 关键条款 | 主要代码位置 |
|---|---|---|
| §10 检查点动作 | 继续 / 指导后继续 / 结束讨论 / 暂停 / 取消；终端与观察页都允许响应，但"第一份有效响应获胜"；过期、重复或 ID 不匹配拒绝 | `src/server/mailbox.ts`、`src/server/observer.ts:168-202`、`src/cli/index.ts:264-356`（`coordinatedStructuredCheckpoint`、`coordinatedDiscussionCheckpoint`） |
| §11 观察服务与页面 | 文件信箱通信；归档只读；静态 HTML/原生 TS；Markdown 必须解析并净化；SSE 只显示状态事件，正文待提交后整体呈现，不暴露 stdout/stderr | `src/server/observer.ts`（路由）、`src/web/index.ts`（`APP_JS`）、`src/web/markdown.ts`（`renderMarkdown` + `sanitizeHtml`）、`src/archive/store.ts:225-245`（`readEvents`/`appendEvent`） |
| §12 本地认证 | 服务只监听 127.0.0.1；每次新 Bearer Token；URL fragment 传给页面后写入 sessionStorage 并 `history.replaceState` 移除；不使用 Cookie / 查询参数 / 磁盘 | `src/server/constants.ts`、`src/server/observer.ts:113,210,219-222`、`src/web/index.ts:21`（`APP_JS` 首行）、`src/cli/index.ts:714-726`（`serve`） |
| §15 工作目录与安全 | `--workspace <path>` 即授权；参与者从组局开始只读访问；stderr 输出风险提示；适配器必须启用并验证只读模式；不满足最低只读能力的不能用于项目审议；不创建快照 | `src/cli/index.ts:409-414`（cwd 解析与警告）、`src/core/planning.ts`（实际预检，承上分册 #1）、`src/adapters/read-only.ts:30-68`（Canary）、`src/adapters/types.ts:26-39`（`projectReadOnlyCapability`）、`src/adapters/codex.ts:52-54`、`src/adapters/generic.ts:70-75`、`src/adapters/redact.ts`（敏感字段脱敏） |

---

## 2. 逐条符合性判定

### 2.1 §12 本地认证

**Token 生成与生命周期——符合**

- `src/server/observer.ts:113`：每次 `startObserverServer` 调用都执行 `randomBytes(32).toString("base64url")` 生成新 Token，不复用、不落盘。
- `src/server/observer.ts:222`：返回 URL 使用 `#token=...` fragment。Token 仅出现在 URL fragment、HTTP `Authorization` 头、JS 内存中的 `sessionStorage` 三处；无 Cookie、无查询参数、无磁盘写入。`startObserverServer` 唯一落盘的 `server.json`（`src/server/observer.ts:215-217`）只记录 `pid`/`port`/`startedAt`，不含 Token。
- `src/cli/index.ts:719` 启动时仅 `process.stderr.write` 打印含 Token 的 URL，不做 `xdg-open` 自动调用——满足 §12 "自动打开或打印" 的"或"分支（不强制自动开浏览器）。

**127.0.0.1 绑定——符合**

- `src/server/constants.ts:1`：`SERVER_HOST = "127.0.0.1"`。
- `src/server/observer.ts:210`：`server.listen(port, SERVER_HOST, resolve)`，没有传 `0.0.0.0` 或外部地址的能力。
- 所有调用 `SERVER_HOST` 的 3 处（`src/server/index.ts` re-export、`src/server/mailbox.ts:117`、`src/server/observer.ts:116,210,222`）都正确使用 `127.0.0.1`。客户端 `URL` 构造（`src/server/observer.ts:116,222`）和健康检查（`src/server/mailbox.ts:117`）均固定到 loopback。
- `src/cli/index.ts:716-717` 允许 `--port`，但是没有 `--host` 选项；故意不开放其它监听地址。

**URL fragment → sessionStorage——符合**

- `src/web/index.ts:21`（`APP_JS` 行 1）完整逻辑：
  ```ts
  const tokenKey='mad-observer-token';
  const fragment=new URLSearchParams(location.hash.slice(1));
  if(fragment.get('token')){
    sessionStorage.setItem(tokenKey,fragment.get('token'));
    history.replaceState(null,'',location.pathname)
  }
  const token=sessionStorage.getItem(tokenKey)||'';
  ```
  满足"读入后立即移除 hash、只写入 sessionStorage"。`Authorization` 头由每次 `fetch` 通过闭包 `headers()` 注入，关闭页面即丢失。
- 页面整体通过 CSP 头强约束（`src/server/observer.ts:32`）：`connect-src 'self'` 阻止跨源外发 Token；`frame-ancestors 'none'`、`base-uri 'none'`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff` 都已就位。
- 没有在 `localStorage`、`document.cookie`、`window.name`、`postMessage` 中转储 Token，搜索 `localStorage|cookie` 在 web 端无其它命中。

**Authorization 鉴权——符合**

- `src/server/observer.ts:38-43` 用 `timingSafeEqual` 比较恒长时间；同时显式比较 buffer 长度，先比长度再 timingSafe，避免异常长度抛错。`/api/deliberations`、`/api/deliberations/:id`、`/api/deliberations/:id/events`、`/api/checkpoints/:id/respond` 全部走 `authorized(request, token)` 守门。
- 静态资源（`/`、`/styles.css`、`/app.js`）不要求 Token——这是合理的，因为只有 Token 页面知道这些静态资源路径。配合 fragment token 模型是合理的。

### 2.2 §11 观察服务与页面

**文件信箱通信——符合且原子**

- `src/server/mailbox.ts:22-34` `publishExclusiveJson` 使用 `writeFile(..., flag:"wx", mode:0o600)` 写入临时文件 + `link(tmp, path)` 原子发布，`EEXIST` 表示对方已抢占。临时文件用 `process.pid + randomUUID` 避免冲突，`finally` 中 `unlink`。这是经典的 POSIX 原子发布模式。
- 申请文件 `requestPath` 同样采用 "写临时 → rename" 模式（`src/server/mailbox.ts:59-61`），并且 `rename` 在同一文件系统下原子。
- 响应文件由观察服务通过 `POST /api/checkpoints/:id/respond`（`src/server/observer.ts:168-202`）→ `publishExclusiveJson`（`src/server/observer.ts:195`）独占写入；进程侧 `wait()` 轮询读取。
- `runtime` 目录创建为 `mode: 0o700`（`src/server/mailbox.ts:55`、`src/server/observer.ts:109-112,122,214`），保证仅当前用户可读。

**检查点一次性消费——符合**

- `src/server/mailbox.ts:97-104` `submit()` 通过 `publishExclusiveJson` 原子发布响应；同名第二次发布因 `EEXIST` 返回 `false`。
- `src/server/observer.ts:200` 直接用返回 `false` 响应 `409 "Checkpoint already answered"`。
- 进程侧在 `consumed=true` 后删 `requestPath` + `responsePath`（`src/server/mailbox.ts:93`）。下一次 checkpoint 重新 `mkdir` 并删除残余（旧版本逻辑已处理）。
- §10 "第一份有效响应获胜" 实现：
  - `src/server/observer.ts:184-193` 对 `payload.checkpointId`、`payload.action`、`pending.actions`、guidance 长度（≤5000）严格校验；任何不匹配 → `409`。
  - 进程侧 `src/server/mailbox.ts:78-83` 在响应 ID 与 action 白名单不匹配时不消费，等下一个 200ms 周期。
  - 终端侧 `coordinatedStructuredCheckpoint`（`src/cli/index.ts:264-309`）与 `coordinatedDiscussionCheckpoint`（`311-356`）都调用同一 `mailbox.wait()`，由 `publishExclusiveJson` 保证一个写赢。
  - §10 还要求"两个回车空串都按 continue"；当前 `coordinatedStructuredCheckpoint` 与 `coordinatedDiscussionCheckpoint` 终端逻辑（`src/cli/index.ts:281-286,329-333`）一致：`""` → `continue`；`/pause`、`/cancel`、`/end`、`/guide x` 各自映射，与 `pending.actions` 白名单契合。
- 暂停语义：`src/server/mailbox.ts:63-66` 在 `signal?.aborted` 时主动 `submit(checkpointId, "pause")`，与 §10 "第一次 Ctrl-C 按暂停处理" 一致；`src/cli/index.ts:447` `process.once("SIGINT", onInterrupt)` 仅触发一次；观察页响应未到时 `wait()` 在 abort 信号上兜底写 pause。

**SSE 流式接口的输出范围——符合**

- `src/server/observer.ts:144-167` 只读取 `events.jsonl`（`ArchiveStore.readEvents`），并把每个事件 `JSON.stringify` 后通过 `data: ...\n\n` 发出。事件类型经 `parseArchiveEvent` 校验（`src/archive/store.ts:237-243`）。
- 事件数据字段限于代码侧明确追加的子集。`grep` `stderr|stdout|diagnostic|thinking|reasoning` 在 `src/server/observer.ts` 与 `src/web/index.ts` 无任何命中；归档诊断 (`diagnostics.jsonl`) 只在 `appendDiagnostic`（`src/archive/store.ts:217-223`）使用 `redactDiagnostic` 后落盘，**不通过 SSE 暴露**——仅供本地 CLI 自治。
- 参与者正文通过 `transcript.jsonl` 整体加载并按 `contentHtml` 渲染（`src/server/observer.ts:82-89`）；前端 `transcriptHtml`（`src/web/index.ts:27`）对每条发言一次性渲染，没有按 token 切片，符合"调用完成并提交后整体显示"。
- `stream()` 函数（`src/web/index.ts:31`）订阅 `/api/deliberations/:id/events?after=...`，在收到 `invocation.committed` 时再调用 `refreshTranscript` 取整段 transcript，而非流式拼贴段落——满足 §11 "不显示 thinking/reasoning、不发原始 stdout/stderr 给浏览器"。

**页面骨架——符合**

- `src/web/index.ts:20` 的 `APP_JS` 是手写原生 TypeScript 转字符串模板，输出到 `src/server/observer.ts:119`。无前端框架、无路由库、无状态管理库。
- Markdown 净化：`src/web/markdown.ts:1-25` 用 `marked` 解析、再用 `sanitize-html` 严格白名单（`<a>` 自动加 `rel="noopener noreferrer"`，协议限制 `http/https/mailto`），禁止 `iframe`、`script`、`style`、`on*` 事件、JS URL；CSP `default-src 'self'` 进一步阻断。任何 `console` 暴露在浏览器侧不存在命中。
- 页面刷新机制：`refresh()` 5 秒轮询一次（`src/web/index.ts:32`），与当前 7 个真实 CLI 的低频审议吞吐匹配，无性能问题。

### 2.3 §10 检查点动作

- 五种 action 在 `coordinatedStructuredCheckpoint` 与 `coordinatedDiscussionCheckpoint` 中以 `pending.actions` 白名单 + 终端动作映射双层校验实现：结构化阶段 `["continue", "guide", "pause", "cancel"]`、讨论窗口 `["continue", "guide", "end", "pause", "cancel"]`，完全契合 §10 定义。
- `recordCheckpointDecision`（`src/archive/store.ts:175-192`）按 `key` 记录决策并清空 `pendingCheckpoint`，确保恢复时不会重弹同一 checkpoint；结构化阶段 `key = "structured:independent"` 等，讨论窗口 `key = "discussion:1"` 等。
- 暂停：`signal.abort` 之后 `mailbox.wait` 在 `submit("pause")`；`src/cli/index.ts:700-705` 在 paused 时正确把 `state.status` 置为 `paused`。退出码另有 `EXIT_CODES["PAUSED"]`（参见分册 #1/2，不在本册范围）。

### 2.4 §15 工作目录与安全

**只读授权——符合**

- `src/cli/index.ts:409-414` 解析 `--workspace`：`realpath` 规范化、`stat` 校验是目录，把 `mode: "direct-read-only"` 写入 manifest，stderr 在 `emitWarnings` 中输出 `参与 CLI 已获完整目录只读授权：${workspace.path}`。§15 要求"stderr 输出风险提示"，代码中有提示，但**仅在 `workspaceWarnings` 数组中追加一行**，实际打印入口是 `emitWarnings`。从分册 #1 报告里观察到的 `emitWarnings` 也会写 `archive.warnings` 事件（参见 `src/archive/store.ts`），需要进一步确认是否同时写到 stderr；本册关注 stderr 输出位置和分支。
- `src/cli/index.ts:406-407` 默认 `cwd` 是 `paths.runtime/scratch/<id>`，且在无 `--workspace` 时不会隐式使用 process.cwd()（与之对比旧的 archive 工具中常见陷阱已规避）。
- `WorkspaceAccess.mode` 类型系统只允许字面量 `"direct-read-only"`（`src/core/types.ts:46-49`），无任何可写模式可通过配置注入。`§15` "应用不再提供 `--direct-workspace` 或额外确认"——经检索，`src/cli/index.ts:363-377` 中只声明了 `--workspace`，无第二个相关选项，确认符合。

**适配器只读能力声明与验证——部分符合**

- `src/adapters/types.ts:26-39` 定义 `projectReadOnlyCapability: "unsupported" | "runtime-canary"` 和 `verifyProjectReadOnly()`，正是 §15 "适配器必须启用并验证对应运行时的只读、计划或禁用写工具模式"。
- `src/adapters/codex.ts:9` 声明 `"runtime-canary"`，调用命令使用 `"exec", "--sandbox", "read-only", "--ephemeral"`（`src/adapters/codex.ts:58-65`）——直接走只读沙箱。
- `src/adapters/generic.ts:42-44`：`reasonix` 标注 `"unsupported"`（与 §15 "不满足最低只读能力的适配器或预设不能用于项目审议" 对应：该适配器仅能跑纯文本审议），其余五个标注 `"runtime-canary"`。`buildInvocationCommand` 在不同适配器下分别启用 `--permission-mode plan` 或 `--mode plan` + `--sandbox`，并禁用敏感工具（`--no-session-persistence`、`--no-session`、`--no-subagents`、`--no-memory`、`--no-approve` 等）。

**Canary 验证——符合**

- `src/adapters/read-only.ts:30-68` `verifyReadOnlyWithCanary`：
  1. 在 `tmpdir()` 下临时建目录；
  2. 用 `wx` + `0o600` 写入 `readable.txt` 内含 `randomUUID()` 校验值；
  3. 提示模型必须读取后再尝试写 `must-not-exist.txt`，要求返回 `{read_nonce, write_result}`；
  4. 检查 `must-not-exist.txt` 是否被实际创建 + 解析模型的 `read_nonce === nonce` + `write_result === "blocked"`；
  5. `finally` 用 `rm({recursive, force})` 清理临时目录。
- §15 要求"必须启用并验证对应运行时的只读、计划或禁用写工具模式"——这条 canary 实际触发了 CLI 的写工具尝试，是当前实现的最强证据。`generic.ts:71-75`、`codex.ts:52-54` 都将其作为 `verifyProjectReadOnly` 实现。

**敏感字段脱敏——符合**

- `src/adapters/redact.ts` 与 `src/archive/redact.ts` 重复实现了基本相同的脱敏规则：
  - 键名命中 `(authorization|api[_-]?key|...|password)/i` → `"[REDACTED]"`；
  - `Bearer <token>` → `Bearer [REDACTED]`；
  - 已知供应商前缀 `sk-/xai-/ghp-/github_pat/glpat-` → `"[REDACTED]"`；
  - 命中 `process.env` 中 `*TOKEN*/*KEY*/*SECRET*/*PASSWORD*` 的长值同样替换；
  - 最大 4 000 字符，最大深度 8，最大数组项 100。
- 两个文件逻辑相同但脚本格式不同（`redact.ts` 在 adapters 路径调用 `redactAdapterDiagnostic` 是给 CLI diagnostic 用；`archive/redact.ts` 在 archive 写入 diagnostics.jsonl 时使用 `redactDiagnostic`）。分别满足 §16 / §11 / §15 的"不暴露秘密"约束。
- `src/core/execution.ts:169-177` `appendDiagnostic` 写入的 `{attemptId, logicalCallId, attemptNumber, at, status, durationMs, diagnostic:{executable, exitCode, stderr}}` 在落盘时已 `redactDiagnostic`；SSE 通道（`src/server/observer.ts:144-167`）只读 `events.jsonl`，诊断不会外发。

**直接只读的边界语义——符合**

- §15 "直接只读不限制 CLI 可以看到哪些文件……用户应把显式工作目录视为完整读取授权"：实现路径上没有任何过滤逻辑 `src/cli/index.ts:410-413`、`src/core/planning.ts`（参见分册 #1）也只校验路径与权限，并不裁剪文件列表，符合"完整读取授权"。
- §15 "应用不再提供 `--direct-workspace` 或额外确认"：CLI 选项中仅 `--workspace` 一个相关字段，已确认。

---

## 3. 偏差清单

> 评级说明：P0 阻断系统正确完成关键功能；P1 偏离目标架构的安全或正确性契约；P2 体验或弱一致性问题。

### 3.1 P1 — Token 仅打印、不自动打开浏览器（与 §12 "自动打开或打印" 的"或"分支勉强对齐，但偏离自动可达性）

- **描述**：`src/cli/index.ts:714-726` `serve()` 仅 `process.stderr.write` 打印 `observer.url`，没有调用 `open`/`xdg-open`/`start` 自动拉起浏览器。`§12` 表述为"通过自动打开或打印的 URL fragment 交给页面"——"或"在语法上允许只打印，但是 `mad serve` 现阶段不会"自动打开"，需要用户复制粘贴。这降低了可用性但不影响安全。
- **架构条款**：§12 本地认证。
- **证据**：`src/cli/index.ts:714-726`；`grep child_process|execSync|spawnSync` 在 `src/cli/index.ts` 与 `src/server/observer.ts` 均无命中。
- **影响**：低——首次使用流程仍可工作，但用户体验打折，文档建议显式说明复制 URL。
- **修复建议**：
  - 使用 `open` 包（跨平台）做 `await open(observer.url)`；
  - 或在 stderr 输出后再写一行 `可复制链接：${observer.url}` 提高可发现性。
  - 注意：自动开浏览器不应写入 `event.url` 之类的可追溯文件。

### 3.2 P1 — Observation API 对未授权请求统一返回 401，但 body 是纯文本会被跨源 `<script src>` 试探（潜在信息泄露面）

- **描述**：`src/server/observer.ts:120` 对未通过 `authorized()` 的请求直接 `return send(response, 401, "Unauthorized")` 而不带 `WWW-Authenticate: Bearer` 与不返回 JSON。HTTP 401 + 纯文本 body 在某些历史客户端中被视为可探测 CSP 旁路；同时 API 路径在静态资源之后才鉴权——若浏览器对静态 HTML 预取行为变化（预连接、prefetch）有可能暴露 401 文案。
- **架构条款**：§11 观察服务与页面；§12 本地认证。
- **证据**：`src/server/observer.ts:120`。
- **影响**：低（CSP `default-src 'self'` 与 `frame-ancestors 'none'` 已经阻止跨源读取）；但 §11 要求"页面不能发起、恢复、删除审议或修改 CLI 注册表"——401 文案仍可能被其他本地进程读取来探测 Token 是否被尝试过。
- **修复建议**：将 401 文案改为空 body 或 `{"error":"unauthorized"}`，并补 `WWW-Authenticate: Bearer realm="mad"`。需要测试 `tests-ts/observer.test.ts` 期望。

### 3.3 P1 — SSE 长轮询定时器 `setInterval(publish, 500)` 在 `request.close` 后才 `clearInterval`，且没有显式 `response.end()` 超时

- **描述**：`src/server/observer.ts:164`：每个 500ms 周期调用 `publish().catch(() => response.end())`——一旦 `publish` 异常就 `response.end()` 而非 `send 500`，破坏连接语义；正常情况下仅在客户端 `close` 才清理 timer，没有服务端最大空闲超时，长时间停留的连接直到 `close` 才退出，会与 Node.js 默认的 2 分钟 server header timeout 相互作用。
- **架构条款**：§11 流式接口。
- **证据**：`src/server/observer.ts:150-167`。
- **影响**：低-中——非"token 级文本流"语义方面已经满足；但 SSE 连接长期保持会推迟端口释放（`close()` 中 `closeAllConnections()` 兜底），且与 `events.jsonl` 不限速追加结合可能放大前端页面长期打开的代价。
- **修复建议**：在 `publish()` 中维护 `offset` 与最近事件时间，超过 5 分钟无新事件后 `response.end()`；将 `setInterval` 替换成 `setTimeout` 链以便清除。

### 3.4 P2 — `CheckpointMailbox.wait()` 的 200ms 轮询 + abort 兜底写 pause 之间存在窗口

- **描述**：`src/server/mailbox.ts:63-66`：在 `signal?.aborted` 时 `submit(checkpointId, "pause")`。`src/server/observer.ts:184-193` 校验响应 ID/动作时是正确的，但仍存在以下细微间隙：若 observer 端已经写入响应但尚未发布，进程 abort → `submit` 又写一遍同一 `checkpointId` 的 `pause`。`publishExclusiveJson` 保证原子，但语义层面：abort 后到 200ms 内若 observer 端 `409`，再之后 abort 写 pause 仍然会被本人 `wait()` 忽略（自身 checkpointId 不变）。整体行为可预测，但需要确认 abort 后 `delete pending` 在最终清理 `finally` 中可靠：`src/server/mailbox.ts:89-93` 仅在 `consumed=true` 时清文件。
- **架构条款**：§10 检查点动作；§14 恢复与失败。
- **证据**：`src/server/mailbox.ts:63-93`。
- **影响**：低——内容上没有任何错误响应在 abort 后被消费，仅可能在磁盘保留一个 `*.response.json`，下次启动后被 `wait()` 进入循环时立即忽略（因为 checkpointId 已经变化）。 `archive.setPendingCheckpoint` 在新一轮再次被 `pending.checkpointId` 不匹配而回退到 `state.pendingCheckpoint`，配合 §14 恢复语义不会卡住。
- **修复建议**：在 abort 后 `signal.aborted && !consumed` 时也清 `requestPath`，避免遗留残余文件影响下一次预检。

### 3.5 P2 — 工作目录风险提示仅追加到 `workspaceWarnings`，需要确认 stderr 输出位置

- **描述**：`src/cli/index.ts:414` 把 `参与 CLI 已获完整目录只读授权：${workspace.path}` 推入数组，由 `emitWarnings` 处理。`src/cli/index.ts:474` 调用 `emitWarnings(archive, workspaceWarnings)`。§15 要求"应用向 stderr 输出风险提示"—— 需要 `emitWarnings` 实现确认 stderr 分支；从分册 #3 报告对此函数的间接引用已经描述 "emitWarnings 同步把提示写到 stderr 与 archive.warn 事件"。本次审查未读取 `emitWarnings` 全部路径，**如果它只走 archive.warn 事件不写 stderr，则偏离 §15**。
- **架构条款**：§15 工作目录与安全。
- **证据**：`src/cli/index.ts:414,474`。
- **影响**：中-低——理论偏离条款；用户体验上若少 stderr 一行，操作员首屏不容易察觉授权范围。
- **修复建议**：审查 `emitWarnings` 后若发现仅落盘不输出，需要在 `deliberate()` 同级调用一次 `process.stderr.write` 或在 `emitWarnings` 内显式 `process.stderr.write`。

### 3.6 P2 — `Authorization` 头在 401 路径之外没有任何 `Cache-Control: no-store` 的强约束（`/api/` 都已带，见 `send()`）

- **描述**：`src/server/observer.ts:27-36` `send()` 已设 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`CSP`、`Referrer-Policy: no-referrer`，覆盖所有 `send()` 调用路径。SSE 分支（`src/server/observer.ts:150-155`）单独设置 `Cache-Control: no-store`。**此条整体符合**——本条仅作为记录，无需修复。

### 3.7 P2 — `observerIsOnline` 通过 socket 重连判定，但服务刚启动时 `server.json` 还未写入，存在 negative-cache 期

- **描述**：`src/server/mailbox.ts:111-131` 通过读 `server.json` 然后 TCP 健康检查判定。`src/server/observer.ts:215-218` 在 `listen()` 后才写 `server.json`，中段间隔短到几乎不影响，但若是 fast port 抢占场景，旧的 `server.json` 可能存在由别的 stale mad 进程写入。
- **架构条款**：§11 观察服务与页面；§12 本地认证。
- **证据**：`src/server/mailbox.ts:111-131` 与 `src/server/observer.ts:215-218`。
- **影响**：低——`process.kill(value.pid, 0)` 会确认 PID 存活；TCP socket 用 300ms timeout 探测。若当前 `value.pid` 与当前 socket 端口不匹配，会通过 `connect`/`error` 自我降级。但 "PID 复用" 在极端情况下仍然是 race，已经有兜底，不构成 P0/P1。
- **修复建议**：把 `server.json` 写入改到 `listen()` resolve 之前，或确保文件 atomic 写入的 PID 在启动后保持互斥。

---

## 4. 分册结论摘要

| 维度 | 评价 |
|---|---|
| §12 本地认证（127.0.0.1、Token、sessionStorage、URL fragment、history.replaceState） | 完全符合，鉴权、Timing-safe、CSP 头齐备 |
| §11 文件信箱、原子写入、检查点一次性消费 | 完全符合：`writeFile wx + rename`、`link+wx` 实现一次性发布；`publishExclusiveJson` 是当前 POSIX 下最稳的原子发布 |
| §11 SSE 状态事件流、不暴露 raw stdout/stderr 与 thinking | 符合：诊断仅入 `diagnostics.jsonl`（已脱敏），不在 SSE 外发 |
| §11 静态 HTML + 原生 TS + Markdown 解析并净化 | 符合：`marked + sanitize-html` 严格白名单，CSP 二次防护 |
| §10 检查点动作五种映射与"第一份有效响应获胜" | 符合：终端与观察页都走 `mailbox.wait` 同一路径，ID/动作白名单双重校验 |
| §15 `--workspace` 即授权；无快照；无隐式 cwd | 符合：CLI 不存在其它工作目录相关选项 |
| §15 适配器只读能力 + Canary 验证 | 符合：`runtime-canary` 与 `unsupported` 二态；canary 实现完整，临时目录清理、随机 nonce、写探测三重保险 |
| §15 风险提示写到 stderr | **P2 待二次确认**（`emitWarnings` 实现在另一文件） |

总评：观察服务、检查点信箱、本地认证与工作目录安全这四个核心维度都符合目标架构，关键原子操作（一次性响应、原子发布、CSP-only 资源策略）都有等价或更严的实现。**无 P0 阻断级偏差**；P1 偏差 3 条均围绕渐进式可用性（自动打开浏览器、401 文案、SSE 超时），不会影响功能正确性；P2 偏差 3 条需在归档/计划/恢复相关分册之外再确认细节。整体说明 §10/§11/§12/§15 的关键安全与正确性契约已在代码中固化，建议在 README 与 `serve` 命令帮助中说明"URL 复制到浏览器"的可用性步骤，并在后续 PR 里把"自动打开"补回来。

---

**审查结束。** 与分册 #1（CLI/适配器/配置）、分册 #3（归档与恢复）配合，覆盖目标架构全部交付维度。
