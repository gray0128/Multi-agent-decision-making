# TypeScript 目标架构符合性审查 — Reasonix 视角

> 审查日期：2026-07-21  
> 审查基线：当前工作区 `HEAD`  
> 对照规范：[TypeScript CLI 与审议观察页目标架构](../../TypeScript目标架构.md)  
> 审查者：Reasonix（系统架构与正确性视角）  
> 产出目录：`docs/审查/reasonix/`

## 1. 总体评估

当前 TypeScript 实现已覆盖目标架构的全部核心能力：组局、结构化审议、自由讨论、透明档案、本地观察服务、认证和检查点文件信箱。所有 14 个测试文件 61 个测试通过，类型检查与构建通过。

但逐条对比目标架构 18 个章节后，仍可识别出以下架构偏差和未满足约束。以下按目标架构章节编号组织。

---

## 2. 逐章符合性检查

### §3 单包代码结构 — ✅ 完全符合

`src/` 下的六个目录（`cli/`, `core/`, `adapters/`, `archive/`, `server/`, `web/`）与目标架构规定的结构完全一致。单一 `package.json`，非 monorepo。

**细微偏差：** 无。

---

### §4 CLI 注册表与模型调用预设 — ⚠️ 存在偏差

| 要求 | 实现状态 | 偏差 |
|---|---|---|
| 方案只能引用 CLI 配置 + 调用预设，不能携带裸模型名 | ✅ `parseDeliberationPlan` 强制使用 cli+preset 引用 | — |
| 不支持 `extra_args` 原始参数透传 | ✅ 无透传机制 | — |
| 两层验证：静态 + 运行时预检 | ✅ `config validate` + `config check` | — |
| 预检失败阻止启动，不自动替换 | ✅ `preflightPlan` 失败抛 `PREFLIGHT` | — |
| `mad init` 只探测已安装 CLI，不猜测模型 | ✅ | — |
| 已有配置默认不覆盖 | ✅ `flag: "wx"` | — |

**偏差：** 无实质性架构偏差。但 §4 规定"方案引用唯一调用组合执行预检"，当前 `preflightPlan` 使用 `InvocationScheduler` 并行执行但没有验证该 Scheduler 是否尊重每个 CLI 的最大并发限制——实际上每个组合单独调用 `check()`，不受参与者也共享的限流器影响，这属于合乎规范的实现选择。

---

### §5 固定组局阶段 — ✅ 完全符合

- 组局器生成审议 Agent ✅
- 方案指定报告 Agent ✅
- 自由讨论指定主持 Agent ✅
- 交互式确认支持确认、修改、重新组局 ✅
- 非交互 `--auto-confirm-plan` 自动接受首次有效方案 ✅
- 共享 CLI/预设的参与者计入争议信号 ✅

**偏差：** 无。阶段顺序 `propose → preflight → confirm` 符合规范。`confirmPlan` 支持 `/regroup` 重新组局和直接 JSON 修改。

---

### §6 CLI 与交互模式 — ⚠️ 存在偏差

| 要求 | 实现状态 | 偏差 |
|---|---|---|
| 默认模式为 `structured` | ✅ `deliberate()` 默认 `"structured"` | — |
| `mad resume` 从档案恢复原模式 | ✅ 从 manifest 读取 | — |
| 默认交互策略为 `guided` | ⚠️ CLI 解析默认为 `guided` | 仅 CLI 层 |
| `--auto` 跳过正常检查点 | ⚠️ `--auto` 参数未被解析 | **P1** |

**偏差 6.1 [P1]：`--auto` 参数未实现。** 目标架构 §6 规定"显式 `--auto` 才跳过正常检查点"。当前 `deliberate()` 的参数解析中无 `--auto` 选项（`src/cli/index.ts:381-426`）。实际上交互策略通过 `interaction` 变量硬编码为 `guided`，从未通过参数切换。`--auto` 模式在帮助文本中列出但无法使用。

---

### §7 结构化审议 — ✅ 完全符合

七个阶段全部实现：
1. 独立陈述 ✅（`parallel("independent", ...)`）
2. 质疑与补充 ✅（`parallel("challenge", ...)`）
3. 修订意见与关键争议信号 ✅（`parseRevision` + `findDisputes`）
4. 争议收敛 ✅（`parallel("convergence", ...)`，仅在有争议时）
5. 报告 Agent 草稿 ✅（`OutcomePipeline.run`）
6. 其他参与者并行审阅 ✅（`reviewers.map`）
7. 报告 Agent 最终修订 ✅（`outcome:report:final`）

同一阶段逻辑并行、受限流器约束 ✅；guided 模式在四个检查点等待 ✅。

**偏差：** 无。

---

### §8 自由讨论 — ✅ 完全符合

- 覆盖周期（每位参与者恰好发言一次）✅
- 主持通过一次性 CLI 调用规划 ✅
- 主持调度计入调用次数但不算发言 ✅
- 同一参与者不能连续发言 ✅（`parseModeratorPlan` 校验）
- 检查窗口边界收敛评估 ✅
- 复用结构化审议成果流水线 ✅

**偏差：** 无。§8 规定"首版不维护长期主持会话"——当前实现符合，每次窗口边界重新调用主持 Agent。

---

### §9 资源、并发与上下文 — ⚠️ 存在偏差

| 要求 | 实现状态 | 偏差 |
|---|---|---|
| 三层约束（默认/按次覆盖/安全最大值）| ✅ `resolveLimits()` | — |
| 全局限流器 + CLI 配置级限流器 | ✅ `InvocationScheduler` 双层 | — |
| 上下文预算声明 | ✅ `contextBudget` 字段 | — |
| Controller 调用前估算输入 | ⚠️ 仅在 `InvocationRunner.run()` 入口处估算 | 部分 |
| 统一滚动摘要 | ✅ `SharedContextManager.snapshot()` | — |
| 摘要 + 发言人完整记录保留 | ✅ | — |

**偏差 9.1 [P2]：上下文估算不够精确。** `estimateTokens` 使用 `ceil(length/4)` 的朴素估算（`src/core/tokens.ts`）。对于 CJK 文本，这是一个合理低估；对于代码块，这是合理的近似；但对于含大量英文的审议内容，实际 token 数通常显著低于此估算。如果所有 CLI 的实际 tokenizer 都比 4 chars/token 更高效，当前估算会过早触发摘要，浪费计算资源。目标架构要求的是"估算"，朴素实现技术上合规但精度不足。

**偏差 9.2 [P2]：自由讨论中每个发言回合都重新计算 snapshot。** `DiscussionController.speak()` 每次调用 `context.snapshot(question)`（`src/core/discussion.ts:160`）。如果在窗口内，摘要已压缩完成，后续 snapshot 不再触发新的摘要调用（`summarizedEntries` 已推进），这没问题。但在覆盖周期首次 snapshot 时可能触发摘要，增加了不必要的模型调用。

---

### §10 检查点动作 — ✅ 完全符合

五个动作全部实现：继续 ✅、指导后继续 ✅、结束讨论 ✅、暂停 ✅、取消 ✅。

第一次 Ctrl-C → AbortController → `PAUSED` 错误 ✅。

**偏差：** 无实质偏差。但 `coordinatedStructuredCheckpoint` 的终端交互和观察页交互在 `mailbox.wait()` 中竞速，符合"第一份有效响应获胜"的要求。

---

### §11 观察服务与页面 — ⚠️ 存在偏差

| 要求 | 实现状态 | 偏差 |
|---|---|---|
| 独立长期运行进程 | ✅ `mad serve` | — |
| 审议不依赖服务 | ✅ guided 有终端回退 | — |
| 文件信箱通信 | ✅ `CheckpointMailbox` | — |
| 静态 HTML/CSS/TS | ✅ 内联资产 | — |
| Markdown 独立解析与净化 | ⚠️ 仅简单转义 | **P2** |
| SSE 展示阶段、回合、调用、耗时、警告 | ⚠️ 页面只显示 `at`/`type` | **P2** |

**偏差 11.1 [P2]：页面 Markdown 渲染过于简陋。** `src/web/index.ts` 中的内联 JS 仅对 Markdown 做基本的代码块识别和换行，不支持标题层级、列表、表格等。目标架构要求"Markdown 必须经过独立解析与净化"，目前实现只能算"字符转义"，缺少真正的 Markdown 解析器。考虑到报告是审议核心输出且包含复杂结构，这个简化影响了页面可用性。

**偏差 11.2 [P2]：SSE 事件展示不完整。** `observer.ts` 的 SSE 端点正确发送完整事件对象（`src/server/observer.ts:136-140`），但内联前端 JS 只提取 `at` 和 `type` 字段（基于 `explore` 报告的发现），丢弃了阶段、Agent、逻辑调用、耗时等数据。目标架构 §11 要求"展示阶段、回合、调用开始与完成、耗时、警告和检查点"。

---

### §12 本地认证 — ✅ 完全符合

- Bearer Token 每次启动随机生成 ✅
- URL fragment 传递，读取后移除 ✅
- 只保存在 `sessionStorage` ✅
- 不进入查询参数、Cookie 或磁盘 ✅
- 固定监听 `127.0.0.1` ✅
- `timingSafeEqual` 比较 ✅

**偏差：** 无。

---

### §13 透明档案 — ✅ 完全符合

六个文件全部生成：
- `manifest.json` ✅
- `state.json` ✅（原子替换）
- `events.jsonl` ✅（只追加）
- `transcript.jsonl` ✅（只追加，按 `logicalCallId` 去重）
- `diagnostics.jsonl` ✅（只追加）
- `report.md` ✅（原子写入）

**偏差：** 无。档案结构完全合规。

---

### §14 恢复与失败 — ✅ 完全符合

- 逻辑调用为最小恢复边界 ✅（`freezeInvocation` → `commitInvocation`）
- 结构化并行阶段保留已完成结果 ✅（`completedInvocations` 检查）
- 自由讨论逐回合提交 ✅
- 瞬时错误 + schema 错误各重试一次 ✅（`RetryableMadError`）
- 确定性错误不重试 ✅（`error instanceof MadError && !(error instanceof RetryableMadError)`）
- 恢复不重新组局 ✅
- 原子全局锁 ✅（`ActiveDeliberationLock`）

**偏差：** 无。

---

### §15 工作目录与安全 — ⚠️ 存在细微偏差

| 要求 | 实现状态 | 偏差 |
|---|---|---|
| 纯文本审议不提供工作目录 | ✅ | — |
| 项目审议 `--workspace <path>` | ✅ | — |
| CLI 只读/计划/禁用写工具模式 | ✅ 各 adapter 注入只读 flag | — |
| 直接只读原始目录 | ✅ | — |
| 风险提示写入 stderr | ✅ | — |

**偏差 15.1 [P3]：`mad config check` 的 probe 使用当前目录。** `validateConfig(true)` 中 `createAdapter(...).check(process.cwd())`（`src/cli/index.ts:113`）。这本身不是项目审议，所以不违反 §15 关于工作目录的规定。但某些 CLI（如 codex）在 `check()` 阶段不需要访问工作目录即可完成预检，使用隐式的 `process.cwd()` 可能导致不必要的文件访问。

---

### §16 stdout、stderr 与退出码 — ✅ 完全符合

- 默认成功 stdout 只包含最终报告 ✅
- `--format json` 完整 JSON 对象 ✅
- 进度/警告进 stderr ✅
- 暂停/取消/配置/预检/执行各自退出码 ✅（EXIT_CODES 2-30）
- JSON 包含审议 ID、状态、模式、报告、参与者、预算使用、警告、档案路径 ✅

**偏差：** 无。

---

### §17 迁移与接管 — ✅ 完全符合

Python 实现已移除。旧配置和档案已不被读取。

---

### §18 暂缓决定 — ✅ 合规

以下数值均已在 Codex 验证后校准：
- 默认参与者数量：4 ✅
- 自由讨论默认检查窗口：6 ✅
- 默认总调用预算：60 ✅
- 默认全局并发：6 ✅
- 独立可执行程序：暂未实现 ✅（符合"等待验证"）

---

## 3. 问题汇总

| 编号 | 严重度 | 章节 | 描述 |
|---|---|---|---|
| R-6.1 | P1 | §6 | `--auto` 交互策略参数未实现 |
| R-9.1 | P2 | §9 | Token 估算过于朴素（ceil(len/4)），对英文内容过度估算 |
| R-9.2 | P2 | §9 | 每个发言回合都重新计算 context snapshot |
| R-11.1 | P2 | §11 | 页面 Markdown 渲染缺少真正的解析器 |
| R-11.2 | P2 | §11 | SSE 事件展示不完整（阶段/Agent/调用/耗时缺失） |
| R-15.1 | P3 | §15 | `config check` 使用隐式 `process.cwd()` |

## 4. 模块设计评价

### 做得好的地方

1. **清晰的域模型**：`core/types.ts` 定义了完整且类型安全的域模型，避免类型散落。
2. **原子档案操作**：`atomicJson()` 使用 temp+rename 模式保证 `state.json`/`manifest.json`/`report.md` 的 POSIX 原子性。
3. **恢复优先设计**：从 `freezeInvocation` → `commitInvocation` 的设计使得恢复边界清晰且可测试。
4. **双层并发控制**：`InvocationScheduler` 的全局 + 每 CLI 限流器设计优雅。

### 需要改进的地方

1. **`cli/index.ts` 过长**（788 行）：混合参数解析、交互式提示、生命周期编排和检查点接线。建议拆分为独立编排模块。
2. **缺少前端构建流程**：所有前端代码为内联字符串，零构建虽然简单但牺牲了可维护性。当 SSE 展示事件完善时，前端复杂度会增加。
3. **适配器配置硬编码**：`buildInvocationCommand` 使用大 switch 语句硬编码各 CLI 参数，不利于第三方贡献新适配器。

## 5. 建议修复顺序

1. **P1：实现 `--auto` 参数**（影响所有机器调用场景）
2. **P2：SSE 事件展示**（影响观察页可用性）
3. **P2：页面 Markdown 渲染**（影响报告阅读体验）
4. **P2：精确 token 估算**（降低不必要的摘要开销）

---

## 变更记录

- 2026-07-21：按 agent 目录重新整理审查报告；修正相对链接与产出归属说明。
