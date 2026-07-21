# stdout 与 CLI 契约审查

- 审查范围：`docs/TypeScript目标架构.md` 第 10、16 节，以及 `src/cli/index.ts`、`src/core/paths.ts`、`src/core/errors.ts`、`tests-ts/cli-e2e.test.ts`。
- 审查日期：2026-07-21。
- 结论：核心机器输出、stderr 分流、非 TTY 的 guided 快速失败、第一次 Ctrl-C 暂停、响应 ID/动作白名单和退出码映射已有实现；但检查点动作模型没有完整覆盖“指导后继续”，信箱的先到先得语义对同一响应文件是原子保证，对过期/重复响应没有完整的显式拒绝/清理语义；部分失败路径会在档案尚未创建时直接报错，且 JSON 只在成功路径输出，暂停/取消等失败结果没有机器可消费的 JSON 状态对象。另有配置校验命令仍把人类文本写入 stdout，与本节对默认“成功”输出的严格解释存在边界冲突。

## 一、第 10 节：检查点动作

### 1. 五种动作是否实现

- **目标要求（引文）**：第 10 节要求“**继续**：进入下一阶段或检查窗口；**指导后继续**：记录用户指导并继续；**结束讨论**：仅自由讨论可用；停止新增发言并进入报告流水线；**暂停审议**：持久化可恢复状态并退出活动进程；**取消审议**：进入不可恢复终态，不生成共同成果，但保留档案。”（`docs/TypeScript目标架构.md:184-188`）
- **代码证据**：结构化终端菜单只识别回车、`/guide`、`/pause`、`/cancel`（`src/cli/index.ts:271-305`，尤其 `src/cli/index.ts:279-284`）；自由讨论终端菜单识别回车、`/guide`、`/end`、`/pause`、`/cancel`（`src/cli/index.ts:319-352`，尤其 `src/cli/index.ts:327-331`）。`CheckpointDecision` 的结构化动作类型只有 `continue | pause | cancel`（`src/core/structured.ts:11-18`，虽不在本次指定核心文件内，但由 CLI 检查点处理直接调用）。自由讨论控制器另外定义 `end`，并在结束后进入报告流程（`src/core/discussion.ts:...`；本次 CLI 证据入口为 `src/cli/index.ts:309-352`）。
- **差异描述**：**部分实现**。继续、暂停、取消均可达；自由讨论的结束讨论可达；指导通过信箱 `action: "guide"` 转换为 `continue` 并携带 guidance 记录（`src/cli/index.ts:293-305`、`src/cli/index.ts:340-352`），语义上覆盖指导后继续。但结构化检查点的领域类型不承认独立的指导动作，且五种动作并不是统一的、显式的领域动作模型；“指导后继续”被折叠成 `continue + guidance`，可恢复档案中的正式决策也只保存 `action: "continue"`。如果契约要求五种可审计动作逐一可见，这里不一致。
- **严重度**：中。

### 2. 第一次 Ctrl-C 是否按暂停处理并终止当前 CLI 子进程

- **目标要求（引文）**：第 10 节要求“第一次 `Ctrl-C` 按暂停处理，并终止当前 CLI 子进程。”（`docs/TypeScript目标架构.md:190`）
- **代码证据**：CLI 安装一次 `SIGINT` 处理器并调用 `interrupt.abort()`（`src/cli/index.ts:441-445`）；该 signal 传给组局器调用运行器（`src/cli/index.ts:472-489`）和结构化/自由讨论控制器（`src/cli/index.ts:517-536`）。归档创建后，捕获 `MadError("PAUSED")` 时把 planning 状态写为 `paused`（`src/cli/index.ts:558-567`）；顶层按 `EXIT_CODES.PAUSED = 20` 退出（`src/cli/index.ts:783-787`、`src/core/errors.ts:26-34`）。端到端测试在收到“审议已创建”后发送 SIGINT，并断言退出码 20、stdout 为空、档案状态 paused（`tests-ts/cli-e2e.test.ts:180-215`）。参与者进程终止依赖 `InvocationRunner` 接收 AbortSignal；本次指定文件中可见 signal 传递，测试通过 fake CLI 延迟验证主动中断路径（`tests-ts/cli-e2e.test.ts:183-208`）。
- **差异描述**：**已实现（在审查证据范围内）**。第一次 SIGINT 转为 abort，运行器收到 abort，已有 E2E 验证暂停及无半截 stdout。代码没有单独维护“第几次 Ctrl-C”计数或把第二次 Ctrl-C 定义为另一动作；但目标只明确第一次行为，现有实现满足该行为。
- **严重度**：低。

### 3. 终端与观察页是否先到先得，过期/重复/ID 不匹配响应是否拒绝

- **目标要求（引文）**：第 10 节要求“终端与观察页的第一份有效检查点响应获胜；过期、重复或 ID 不匹配的响应被拒绝。”（`docs/TypeScript目标架构.md:190`）。
- **代码证据**：检查点请求生成 `checkpointId`，请求写入包含 deliberationId、checkpointId、动作白名单和 createdAt（`src/server/mailbox.ts:46-61`）；响应使用独占发布，已有响应文件时 `link` 返回 EEXIST 并返回 false（`src/server/mailbox.ts:21-32`、`src/server/mailbox.ts:96-103`）。消费端只接受 `response.checkpointId === checkpointId && pending.actions.includes(response.action)`（`src/server/mailbox.ts:74-86`）。观察服务响应 API 还校验路径中的审议 ID、请求中的当前 checkpointId 与 action（对应 `src/server/observer.ts` 的响应处理；本次代码图显示其被 `checkpoint` 调用）。CLI 通过 `existingCheckpointId` 在恢复时复用当前未完成检查点，且成功消费后才删除请求/响应文件（`src/cli/index.ts:271-305`、`src/cli/index.ts:319-352`、`src/server/mailbox.ts:46-57、77-93`）。
- **差异描述**：**部分实现**。同一响应文件的原子独占写入保证“第一份成功发布者”获胜；消费端拒绝 ID 不匹配和不在当前动作白名单的响应，重复发布在文件已存在时返回 false。可是 `CheckpointMailbox.wait()` 对读到的过期/错误 ID 响应只是不接受后继续轮询，没有删除或显式记录“拒绝”；在一个旧响应文件存在且 `wait()` 刚开始时默认会删除它（`src/server/mailbox.ts:54-56`），但恢复时有 `existingCheckpointId` 则不删除（同处），因此旧/重复响应可能残留并持续轮询。终端和观察页之间也没有共享一个显式“已获胜”确认事件，语义主要由响应文件竞争实现。若要求明确、可观测地拒绝所有过期/重复响应，当前实现不足。
- **严重度**：中。

### 4. guided 模式无终端且无在线观察服务是否立即失败

- **目标要求（引文）**：第 6 节明确“guided 模式既无交互终端也无在线观察服务时立即失败，不无限等待。”（`docs/TypeScript目标架构.md:128`）；第 10 节审查范围要求覆盖这一行为。
- **代码证据**：`deliberate()` 先检查 `process.stdin.isTTY && process.stderr.isTTY` 与 `observerIsOnline(paths.runtime)`，无任一通道即抛 `USAGE`（`src/cli/index.ts:388-401`）；`resume()` 同样在恢复前检查，抛出“恢复 guided 审议需要交互终端或在线观察服务”（`src/cli/index.ts:600-604`）。`observerIsOnline()` 读取 server.json、校验 pid/port，并以 300ms socket 超时探测服务（`src/server/mailbox.ts:110-130`）。
- **差异描述**：**已实现**。检查发生在创建审议档案和进入 mailbox 轮询之前，因此没有无通道无限等待。注意 guided + 无 TTY + `--auto-confirm-plan` 仍要求观察服务；该行为与“观察服务或交互终端”约束一致。
- **严重度**：低。

## 二、第 16 节：stdout、stderr 与退出码

### 5. 默认成功 stdout 是否只包含最终 Markdown 报告

- **目标要求（引文）**：第 16 节要求“默认成功时，stdout 只包含最终 Markdown 报告。”（`docs/TypeScript目标架构.md:249`）
- **代码证据**：`deliberate()` 成功的 markdown 分支仅写 `result.report`（`src/cli/index.ts:537-556`，特别是 `src/cli/index.ts:555`）；`resume()` 同样仅写报告（`src/cli/index.ts:703-720`，特别是 `src/cli/index.ts:720`）。进度、组局方案和档案路径均用 `process.stderr.write` 输出（`src/cli/index.ts:471-479`、`src/cli/index.ts:502-503`、`src/cli/index.ts:557`）。E2E 的 JSON 测试确认 stdout 可单行 JSON，失败测试确认 stdout 为空（`tests-ts/cli-e2e.test.ts:67`、`tests-ts/cli-e2e.test.ts:93-94`）。
- **差异描述**：**已实现**，针对 `deliberate`/`resume` 成功路径成立。边界问题是 `mad config validate/check` 的成功摘要仍写入 stdout（`src/cli/index.ts:120-124`）；若第 16 节“默认成功”适用于所有成功命令，则这是**过度/未统一实现**，因为这两个命令没有最终 Markdown 报告。对于审议命令本身没有差异。
- **严重度**：低。

### 6. `--format json` stdout 是否只有一个完整 JSON 对象

- **目标要求（引文）**：第 16 节要求“`--format json` 时，stdout 只包含一个完整 JSON 对象。”（`docs/TypeScript目标架构.md:250`）
- **代码证据**：成功完成时 JSON 分支单次 `process.stdout.write(JSON.stringify(...)+"\\n")`（`src/cli/index.ts:537-553`）；恢复成功同样单次写入（`src/cli/index.ts:703-719`）。E2E 直接 `JSON.parse(result.stdout)`，并断言 JSON 只有一行（`tests-ts/cli-e2e.test.ts:55-67`、`tests-ts/cli-e2e.test.ts:101-105`）。
- **差异描述**：**已实现**，成功路径没有把进度或日志混入 stdout。`--format json` 不是 `init/config/serve` 的通用选项，这与审议/恢复机器调用范围相符。
- **严重度**：低。

### 7. 进度、警告、Token 地址、档案路径是否进入 stderr

- **目标要求（引文）**：第 16 节要求“进度、警告、Token 地址和档案路径进入 stderr。”（`docs/TypeScript目标架构.md:251`）
- **代码证据**：组局进度和档案创建/最终路径写 stderr（`src/cli/index.ts:471-479`、`src/cli/index.ts:557-557`）；工作目录警告写 stderr（`src/cli/index.ts:407-412`）；观察服务的 URL 和 Bearer Token 说明写 stderr（`src/cli/index.ts:740-741`）；配置预检进度写 stderr（`src/cli/index.ts:109-117`）。成功 JSON 的 `warnings` 与 `archive_path` 是机器对象字段，同时路径也写 stderr（`src/cli/index.ts:537-557`、`src/cli/index.ts:703-721`）。
- **差异描述**：**已实现**。观察服务打印 URL（含 fragment 中 token 的交付地址）只走 stderr；没有发现把进度、警告、路径写进审议成功 stdout 的路径。
- **严重度**：低。

### 8. 非 TTY 输出是否不包含 ANSI 控制字符

- **目标要求（引文）**：第 16 节要求“非 TTY 输出不含 ANSI 控制字符。”（`docs/TypeScript目标架构.md:253`）
- **代码证据**：CLI 输出均为普通字符串模板和 JSON/报告写入（`src/cli/index.ts:38-51`、`src/cli/index.ts:471-479`、`src/cli/index.ts:537-557`、`src/cli/index.ts:783-787`），未见颜色库、终端样式码或 `\\x1b`；E2E 子进程 stdin/stdout/stderr 均为 pipe/ignore（`tests-ts/cli-e2e.test.ts:14-17`），并对机器 stdout 做 JSON 解析（`tests-ts/cli-e2e.test.ts:47-70`）。
- **差异描述**：**已实现**。当前指定 CLI 输出路径没有 ANSI 生成逻辑，非 TTY 下自然保持纯文本。测试未专门断言正则排除 ANSI，但代码证据支持该结论。
- **严重度**：低。

### 9. 失败时是否不向 stdout 写半截 JSON

- **目标要求（引文）**：第 16 节要求“失败时不向 stdout 写半截 JSON。”（`docs/TypeScript目标架构.md:253`）
- **代码证据**：JSON 只在 `run()` 成功返回之后一次性调用 `JSON.stringify` 并写 stdout（`src/cli/index.ts:518-555`、`src/cli/index.ts:679-720`）；统一错误处理只写 stderr、设置退出码（`src/cli/index.ts:783-787`）。E2E 失败场景断言 stdout 为空（`tests-ts/cli-e2e.test.ts:38-45`、`tests-ts/cli-e2e.test.ts:89-97`）。
- **差异描述**：**已实现**。没有流式 JSON 写入；失败发生在写入前时 stdout 保持空。成功时也只有一次完整 write。若 `process.stdout.write` 自身在写入中途发生 I/O 故障，Node 层仍可能留下半截输出，但这是未处理的底层输出错误，不是当前业务失败路径。
- **严重度**：低。

### 10. 暂停、取消、配置错误、预检失败、执行失败是否使用不同退出码

- **目标要求（引文）**：第 16 节要求“暂停、取消、配置错误、预检失败和执行失败使用不同退出码。”（`docs/TypeScript目标架构.md:254`）
- **代码证据**：错误码定义为 `USAGE | CONFIG | PREFLIGHT | LOCKED | PAUSED | CANCELLED | EXECUTION`（`src/core/errors.ts:1-8`）；退出码映射为配置 3、预检 4、暂停 20、取消 21、执行 30（`src/core/errors.ts:26-34`）；顶层统一按错误码设置 `process.exitCode`（`src/cli/index.ts:783-787`）。E2E 验证递归/执行错误 30、锁冲突 5、暂停 20（`tests-ts/cli-e2e.test.ts:38-45`、`tests-ts/cli-e2e.test.ts:108-127`、`tests-ts/cli-e2e.test.ts:180-215`）。
- **差异描述**：**部分实现**。错误码表和顶层映射完整，正常抛出的 `MadError` 确实区分上述类别；但若底层普通错误在配置加载、文件系统或适配器阶段直接抛出，会被顶层包装成 `EXECUTION`（`src/cli/index.ts:783-785`），而不是始终按配置/预检类别归类。更关键的是，组局前的配置加载和 guided 通道检查发生在档案创建及 `try/catch` 之前（`src/cli/index.ts:388-446`），因此错误不会建立档案状态，也没有统一的结构化失败结果。退出码“映射存在”已实现，端到端覆盖不完整。
- **严重度**：中。

### 11. JSON 是否至少包含审议 ID、状态、模式、报告、参与者、预算使用、警告、档案路径

- **目标要求（引文）**：第 16 节要求 JSON 至少包含“审议 ID、状态、模式、报告、参与者、预算使用、警告和档案路径。”（`docs/TypeScript目标架构.md:255`）
- **代码证据**：`deliberate()` JSON 对象包含 `deliberation_id`、`status`、`mode`、`report`、`participants`、`budget_usage`、`warnings`、`archive_path`（`src/cli/index.ts:537-553`）；`resume()` 同样包含这些字段（`src/cli/index.ts:703-719`）。E2E 解析并断言 status、mode、report、warnings、budget_usage、archive_path（`tests-ts/cli-e2e.test.ts:55-70`、`tests-ts/cli-e2e.test.ts:101-105`）。
- **差异描述**：**已实现**，成功 JSON 满足字段下限。参与者使用完整 `plan.participants`，预算使用含调用次数、最大调用数、超时、上下文预算和全局并发，警告和档案路径均有。
- **严重度**：低。

## 三、审查结论与范围边界

1. **已实现**：审议/恢复成功时 markdown 与 JSON stdout 分流；进度、警告、Token 地址和档案路径 stderr 分流；非 TTY 无 ANSI 生成；成功前单次 JSON 写入；成功 JSON 字段齐全；guided 无通道立即失败；错误码常量区分暂停、取消、配置、预检和执行；第一次 Ctrl-C 的暂停与退出码 20 有 E2E 证据。
2. **部分实现**：检查点五动作通过不同命令字符串拼接而成，指导后继续不作为独立动作持久化；响应竞争保证了原子“第一份写入获胜”和 ID/动作校验，但没有显式清理/记录所有过期与重复响应；底层普通异常的错误分类并不始终符合目标类别。
3. **需注意的契约边界**：`mad config validate/check` 成功文本写 stdout（`src/cli/index.ts:120-124`），不属于审议报告输出；若第 16 节被解释为仅约束 deliberate/resume，则不构成问题，若解释为全 CLI，则需另行统一机器/人类输出策略。
4. 本报告不评价第 10、16 节之外的章节，也未读取 `docs/审查/` 下任何既有报告。

创建时间：2026-07-21
创建概要：首次创建 stdout 与 CLI 契约审查报告，依据目标架构第 10、16 节及指定 TypeScript CLI、路径、错误码和 E2E 测试，记录检查点动作、响应竞争、guided 通道、stdout/stderr 分流、非 TTY、失败输出、退出码和 JSON 字段的实现差异。
