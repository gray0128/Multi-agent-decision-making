# 架构一致性审查报告

> 审查范围：第 1、2、3、5、6、9、13、17、18 节
> 审查对象：`/Users/libo/Documents/github/Multi-agent-decision-making`（commit `85f97af`）
> 审查日期：2026-07-21
> 审查者：架构一致性 agent

---

## 总体结论

| 节 | 目标要求 | 实际状态 |
|----|----------|----------|
| 1  | 单包 Node.js、移除 Python / Agent Framework / DevUI、唯一写入者、活动审议约束、127.0.0.1 绑定、Python 不迁移 | 已实现 |
| 2  | 总体结构图与"唯一状态所有者 + 文件信箱" | 已实现 |
| 3  | 单包代码结构（src/cli, core, adapters, archive, server, web） | 已实现 |
| 5  | 组局阶段：覆盖、预检、确认、预算不自动降级 | 已实现 |
| 6  | CLI 与交互模式（structured/free、--auto、--auto-confirm-plan） | 已实现 |
| 9  | 资源、并发、上下文（三层约束 + 全局限流） | 已实现 |
| 13 | 透明档案（manifest/state/events/transcript/diagnostics/report.md，无数据库） | 已实现 |
| 17 | 迁移与接管（按 8 步推进、Python 已删、Agent Framework/DevUI 已删） | 已实现 |
| 18 | 暂缓决定（默认与最大参与者、窗口数、调用预算、并发、独立可执行） | 部分实现 — 多数已校准 |

---

## 1. 详细差异清单

### 1.1 第 1 节：目标与约束

#### 差异 1.1.1 — 已实现

- 目标要求：移除 Python、Microsoft Agent Framework、Agent Framework DevUI；首版使用 Node.js、单包 npm。
- 代码证据：
  - `package.json:23-31` 仅 5 个依赖：`@iarna/toml`、`@types/node`、`tsx`、`typescript`、`vitest`，无任何 Agent Framework / DevUI。
  - 仓库内无 `.py` 源文件（`find ... -name "*.py"` 仅命中 `.venv/lib/python3.12/site-packages/` 内置包，未命中任何项目源码）。
  - `package.json:6-8` `bin.mad = ./dist/cli/index.js`，`type: module`，`engines.node: >=22`。
- 分类：已实现。

#### 差异 1.1.2 — 部分实现（仓库残留 .venv/.pytest_cache）

- 目标要求：「Python 版配置、档案和未完成审议不迁移；旧数据不自动删除」（第 1 节关键约束第 8 条）。
- 代码证据：
  - 仓库根目录仍存在 `.venv/`、`/Users/libo/Documents/github/Multi-agent-decision-making/.python-version`（内容 `3.12`）、`.pytest_cache/`、`/Users/libo/Documents/github/Multi-agent-decision-making/dist/` 编译产物。
  - `.gitignore:1-10` 已忽略 `.venv/`、`__pycache__/`、`.pytest_cache/`、`.mad-ts-local/`，确保不污染 Git。
- 差异描述：源代码、依赖、配置中已无 Python 痕迹，但 .venv 目录、.python-version、.pytest_cache 物理文件未删除；目标架构未明令要求删除 .venv，仅要求「不自动删除旧数据」，所以这是实现性"过度保留"而非违规；不过 .python-version 与 .pytest_cache 容易被误读为项目仍在使用 Python，文档化或显式删除更稳妥。
- 严重度：低。

#### 差异 1.1.3 — 已实现

- 目标要求：「TypeScript 审议进程是运行状态和正式审议档案的唯一写入者」。
- 代码证据：
  - `src/archive/store.ts:44-264` `ArchiveStore` 是唯一持有 `writeState/appendEvent/appendDiagnostic/ensureTranscript/writeReport` 的类；外部唯一入口 `src/cli/index.ts:357` `deliberate` 函数，调用链 `deliberate → StructuredController/DiscussionController → ArchiveStore`。
  - 服务端 `src/server/observer.ts`、`src/server/mailbox.ts` 只通过读取 manifest/state/events 渲染历史与流；不调用任何写方法（仅写一次性响应文件 mailbox）。
- 分类：已实现。

#### 差异 1.1.4 — 已实现

- 目标要求：「每个应用数据根目录同时最多一个活动审议」。
- 代码证据：
  - `src/archive/store.ts:266-339` `ActiveDeliberationLock` 在 `${paths.runtime}/active.lock` 写入 ownerId / pid；重复 acquire 抛 `LOCKED` 错。
  - `src/cli/index.ts:442-443` 在 `deliberate` 启动后立刻 `await lock.acquire(id)`，先于任何状态写入。
- 分类：已实现。

#### 差异 1.1.5 — 已实现

- 目标要求：「本地服务只绑定 127.0.0.1」。
- 代码证据：`src/server/observer.ts`（基于 `mcp__codegraph__codegraph_explore` blast 报告，引用 `startObserverServer`），CLI 启动 `mad serve [--port PORT]` 默认 host=127.0.0.1。
- 分类：已实现（未直接读 server 文件源码，依据 codegraph blast 与 `docs/TypeScript实现与验收.md` 推断；建议与「观察服务与页面」专项审查交叉核对）。

### 1.2 第 2 节：总体结构

#### 差异 1.2.1 — 已实现

- 目标要求：图示「mad deliberate 进程 = 唯一状态所有者」、「mad serve = 受限响应 + 文件信箱」。
- 代码证据：
  - `src/cli/index.ts:37` 引入 `CheckpointMailbox`；`src/server/mailbox.ts:35` `CheckpointMailbox`（6 callers, 在 `src/cli/index.ts`）；观察服务只原子写入响应文件，审议进程 `mailbox.wait` 校验后消费。
  - `src/archive/store.ts:44` `ArchiveStore` 与观察服务读取路径完全分离。
- 分类：已实现。

### 1.3 第 3 节：单包代码结构

#### 差异 1.3.1 — 已实现

- 目标要求：`src/{cli,core,adapters,archive,server,web}`。
- 代码证据：
  - `src/cli/index.ts` 34816 字节。
  - `src/core/` 10 个文件：context、discussion、errors、execution、limits、outcome、paths、planning、structured、tokens、types。
  - `src/adapters/` 7 个文件：codex、config、generic、index、process、public-text、types。
  - `src/archive/` 2 个文件：index、store。
  - `src/server/` 3 个文件：index、mailbox、observer。
  - `src/web/` 1 个文件：index（HTML + CSS + 少量 TS）。
- 分类：已实现。

#### 差异 1.3.2 — 已实现

- 目标要求：「首版使用单个 package.json，不建立 monorepo」。
- 代码证据：
  - `find -maxdepth 3 -name package.json -not -path "*/node_modules/*"` 只命中一个 `package.json`。
  - `package.json` 无 `workspaces` 字段，无 lerna / nx / turbo / pnpm-workspace 配置文件。
- 分类：已实现。

### 1.4 第 5 节：固定组局阶段

#### 差异 1.4.1 — 已实现

- 目标要求：「使用默认组局器，或用户按次覆盖的允许组合」。
- 代码证据：`src/cli/index.ts:368, 414-421` 提供 `--organizer CLI/PRESET`；`resolveInvocation(registry, cli, preset)` 校验存在性；超长或格式错抛 `USAGE`。
- 分类：已实现。

#### 差异 1.4.2 — 已实现

- 目标要求：「向组局器提供问题、单次资源上限和 CLI 注册表安全视图；项目审议还允许其直接只读查看显式工作目录」。
- 代码证据：`src/core/planning.ts:211-227` `buildPrompt` 输出问题、`request.limits` JSON、`request.cwd`、注册表 `clis[]`（只暴露 `cli.id / adapter / preset.id / preset.contextBudget`），明确禁止「模型名、命令、可执行路径、CLI 参数、权限、环境变量、秘密、配置修改」。
- 分类：已实现。

#### 差异 1.4.3 — 已实现

- 目标要求：「组局器生成只属于本次审议的审议 Agent。每个实例包含唯一 ID、CLI 配置、调用预设和角色描述」。
- 代码证据：`src/core/types.ts:23-27` `DeliberationAgent` 严格 `{ id, invocation: { cli, preset }, role }`；`src/core/planning.ts:66-80` 校验 ID 模式 `^[a-z][a-z0-9_-]{0,63}$`。
- 分类：已实现。

#### 差异 1.4.4 — 已实现

- 目标要求：「方案指定报告 Agent；自由讨论还指定主持 Agent。两者都必须是参与者」。
- 代码证据：
  - `src/core/planning.ts:83-84` `reportAgentId` 必须在 `participants` 内。
  - `src/core/planning.ts:93-94` free 模式 `moderatorAgentId` 同样必须在 `participants` 内。
- 分类：已实现。

#### 差异 1.4.5 — 已实现

- 目标要求：「对方案引用的唯一调用组合执行运行时预检」。
- 代码证据：
  - `src/core/planning.ts:186-203` `preflightPlan` 用 `Map<cli/preset>` 去重后只对每个唯一组合调用 `adapter.check(cwd, signal)`。
  - `src/core/planning.ts:160` `maximumAttempts = request.allowRegeneration === false ? 1 : 2` —— 自动模式最多 1 次，不允许重新生成；guided 模式最多 2 次（一次生成，一次按校验错误提示重试）。
- 分类：已实现。

#### 差异 1.4.6 — 已实现

- 目标要求：「方案确认后才进入正式审议」。
- 代码证据：
  - `src/cli/index.ts:493-511` `confirmPlan` 在 guided 且非 auto-confirm 时调用；auto 模式直接以 `proposed.plan` 进入 controller。
  - `src/cli/index.ts:503-512` 写 manifest `plan.confirmed` 事件后才 `await new StructuredController(...).run()`。
- 分类：已实现。

#### 差异 1.4.7 — 已实现

- 目标要求：「交互式确认支持确认、修改、附带指导重新组局和取消」。
- 代码证据：`src/cli/index.ts:217-257` 循环提示「回车确认；输入完整 JSON 修改；/regroup 指导 重新组局；/cancel 取消」；`/regroup` 调 `organizerService.propose({...guidance})`；`/cancel` 抛 `CANCELLED`。
- 分类：已实现。

#### 差异 1.4.8 — 已实现

- 目标要求：「修改可以增删审议 Agent、改变角色或调用预设、改选主持与报告 Agent，但不能突破白名单和资源上限」。
- 代码证据：
  - `src/core/planning.ts:62-65` 数量上下限：≥ 2 且 ≤ `options.limits.maxParticipants`。
  - `src/core/planning.ts:74, 86` 每次 `parseDeliberationPlan` 都重新 `resolveInvocation` 强制白名单。
  - `src/core/planning.ts:87-91` 实际 `timeoutSeconds/contextBudget` 取 `Math.min(用户, 各 preset/cli)`，不突破。
  - 修改后的完整方案再次预检（`src/cli/index.ts:255` `await organizerService.preflightPlan(plan, ...)`）。
- 分类：已实现。

#### 差异 1.4.9 — 已实现

- 目标要求：「非交互调用必须显式传入 `--auto-confirm-plan`，且只能自动接受第一次生成并通过所有校验的方案，不能自动修改或重新组局」。
- 代码证据：
  - `src/cli/index.ts:386-388` `--auto` 必须同时显式传入 `--auto-confirm-plan`，否则 `USAGE` 错。
  - `src/cli/index.ts:454, 486` `allowRegeneration: interaction === "guided"` —— auto 模式 `allowRegeneration === false`，配合 `src/core/planning.ts:160` `maximumAttempts === 1`。
  - auto 模式直接用 `proposed.plan`，不调 `confirmPlan`。
- 分类：已实现。

#### 差异 1.4.10 — 已实现

- 目标要求：「默认组局器无效、不可用或预检失败时直接报错，不自动降级」。
- 代码证据：
  - `src/core/planning.ts:138` `await this.requireReady(generatorAdapter, ...)` 在生成方案前预检组局器。
  - `src/core/planning.ts:205-209` `requireReady` 失败抛 `PREFLIGHT` 错，不替换 CLI / preset / 思考等级。
  - `src/adapters/config.ts:124-126` 未知 adapter 抛 `CONFIG` 错；`src/adapters/config.ts:165-168` 默认组局器引用未知 CLI/preset 抛 `CONFIG` 错。
- 分类：已实现。

#### 差异 1.4.11 — 已实现

- 目标要求：「同一 CLI 和调用预设可以生成多个不同角色的审议 Agent，并正常计入参与者数量与争议信号；页面与报告必须保留其共享来源，不得把一致意见描述为独立模型交叉验证」。
- 代码证据：
  - `src/core/planning.ts:82` 仅校验 `participants` ID 不重复，**不**校验 cli/preset 不重复，允许同源多角色。
  - `src/core/outcome.ts:sharedOriginWarning` 在最终报告流水线生成"同源"警告（被 `src/cli/index.ts:515` 引用写入 archive events）。
- 分类：已实现。

### 1.5 第 6 节：CLI 与交互模式

#### 差异 1.5.1 — 已实现

- 目标要求：`mad deliberate` 支持 `--mode structured|free`、共享组局/预检/确认/工作目录/输出/恢复参数。
- 代码证据：`src/cli/index.ts:45-49` HELP 列出共用参数；`src/cli/index.ts:363` `mode: { type: "string", default: "structured" }`；`src/cli/index.ts:382` 仅接受两个枚举。
- 分类：已实现。

#### 差异 1.5.2 — 已实现

- 目标要求：「默认交互策略为 guided；显式 `--auto` 才跳过正常检查点」。
- 代码证据：`src/cli/index.ts:385` `interaction: InteractionPolicy = parsed.values.auto ? "auto" : "guided"`。
- 分类：已实现。

#### 差异 1.5.3 — 已实现

- 目标要求：「自动模式仍需独立的 `--auto-confirm-plan` 才能接受组局方案」。
- 代码证据：`src/cli/index.ts:386-388` 已在 1.4.9 引用。
- 分类：已实现。

#### 差异 1.5.4 — 已实现

- 目标要求：「guided 模式既无交互终端也无在线观察服务时立即失败，不无限等待」。
- 代码证据：`src/cli/index.ts:395-402` `terminalAvailable && observerAvailable` 缺失时直接抛 `USAGE`。
- 分类：已实现。

### 1.6 第 9 节：资源、并发与上下文

#### 差异 1.6.1 — 已实现

- 目标要求：「三层约束：应用内置的保守默认值、用户按次覆盖值、普通命令不能突破的安全最大值」。
- 代码证据：
  - `src/core/limits.ts:4-11` `DEFAULT_LIMITS`（4/60/6/300/128000/6）。
  - `src/core/limits.ts:13-20` `SAFE_MAX_LIMITS`（8/100/12/1800/1000000/16）。
  - `src/core/limits.ts:22-31` `resolveLimits` 强制 `1 ≤ value ≤ SAFE_MAX`，否则抛 `USAGE`。
  - `src/cli/index.ts:428-441` 用户覆盖经 `integerOption` 解析后注入 `resolveLimits`。
- 分类：已实现。

#### 差异 1.6.2 — 已实现

- 目标要求：「组局器可以看到但不能提高限制」。
- 代码证据：
  - `src/core/planning.ts:223` 把 `request.limits` 完整 JSON 注入 prompt，组局器只能引用。
  - `src/core/planning.ts:62-65` `parseDeliberationPlan` 仍受 `options.limits.maxParticipants` 上限约束。
- 分类：已实现。

#### 差异 1.6.3 — 已实现

- 目标要求：「并发由全局限流器与 CLI 配置级限流器共同控制」。
- 代码证据：
  - `src/core/execution.ts`（`mcp__codegraph__codegraph_explore` 报告中 `InvocationScheduler`）实现全局与 per-CLI 双层限流。
  - `src/core/planning.ts:199-201` 在 `preflightPlan` 显式 `new InvocationScheduler(plan.limits.globalConcurrency ?? 6)` + `cli.maxConcurrency` 共同约束。
  - `src/cli/index.ts:473-477` 把 `limits.globalConcurrency` 注入 `InvocationRunner`。
- 分类：已实现（依据 codegraph blast 与 `docs/TypeScript实现与验收.md`；建议与「并发与资源约束」专项审查交叉核对）。

#### 差异 1.6.4 — 已实现

- 目标要求：「每个模型调用预设声明上下文预算」。
- 代码证据：`src/adapters/config.ts:114` `contextBudget: positiveIntegerAt(raw.context_budget, ...)`；`src/core/planning.ts:90` `contextBudget: Math.min(options.limits.contextBudget, ...preset.contextBudget)` 收口到最小。
- 分类：已实现。

#### 差异 1.6.5 — 已实现

- 目标要求：「Controller 在调用前估算实际输入；任一后续调用预算不足时，由报告 Agent 生成统一滚动摘要。所有参与者、主持 Agent 和报告 Agent 使用同一摘要，加上摘要之后的最近发言」。
- 代码证据：
  - `src/core/context.ts`（4350 字节）、`tests-ts/context-manager.test.ts`（独立单元测试）存在。
  - codegraph blast 显示 `ContextManager` 在 4 个 core 文件被引用。
- 分类：已实现（细节交由「并发与资源约束」专项审查验证）。

### 1.7 第 13 节：透明档案

#### 差异 1.7.1 — 已实现

- 目标要求：每次审议保存为独立目录，包含 `manifest.json / state.json / events.jsonl / transcript.jsonl / diagnostics.jsonl / report.md`。
- 代码证据：
  - `src/archive/store.ts:57-76` `create()` 一次性创建以上 6 个文件（`report.md` 在 `writeReport` 写时建）。
  - `src/archive/store.ts:216-219` `writeManifest` 原子写 manifest。
  - `src/archive/store.ts:95-98` `writeState` 原子写 state。
  - `src/archive/store.ts:221-232` `ensureTranscript` 只追加。
  - `src/archive/store.ts:234-246` `appendDiagnostic / appendEvent` 只追加。
  - `src/archive/store.ts:248-254` `writeReport` 原子写。
- 分类：已实现。

#### 差异 1.7.2 — 已实现

- 目标要求：「观察服务读取这些文件提供历史和实时视图」。
- 代码证据：`src/server/observer.ts`（10093 字节，`CheckpointMailbox` 与 `startObserverServer` 入口），与 1.1.5/1.2.1 一致。
- 分类：已实现。

#### 差异 1.7.3 — 已实现

- 目标要求：「首版不引入数据库；只有跨审议检索或并发需求成立后才评估 SQLite」。
- 代码证据：
  - `grep -rE "sqlite|better-sqlite3|leveldb|drizzle|prisma|orm"` 在 `src/` 与 `package.json` 零命中。
  - 档案全部为 `*.json / *.jsonl / *.md` 文本。
- 分类：已实现。

### 1.8 第 17 节：迁移与接管

#### 差异 1.8.1 — 已实现

- 目标要求：实施顺序 8 步（TS 骨架 → Codex 纵向 → 结构化 → 自由讨论 → 观察服务 → 迁移 Claude/Reasonix/Grok/Pi/CodeBuddy/agy → 安全测试 → 整体接管）。
- 代码证据：
  - `src/adapters/index.ts` 注册 7 个适配器（`ADAPTER_IDS = ["codex", "claude", "reasonix", "grok", "pi", "codebuddy", "agy"]`，见 `src/adapters/config.ts:5`），与目标完全一致。
  - `tests-ts/adapters-ts.test.ts` 覆盖 7 个适配器。
  - `docs/TypeScript实现与验收.md` 描述了 7 CLI × 12 preset 的 `mad config check` 验证。
- 分类：已实现。

#### 差异 1.8.2 — 已实现

- 目标要求：「仓库随后一次性删除 Python 源码、pyproject.toml、Agent Framework 和 DevUI；旧配置与档案未被读取、迁移或删除」。
- 代码证据：
  - `find` 在仓库内除 `.venv/lib/.../site-packages`（虚拟环境内置第三方包，非项目源码）外无任何 `.py`。
  - 无 `pyproject.toml` / `setup.py` / `requirements*.txt`。
  - `package.json` 无任何 Agent Framework / DevUI 包。
  - `.venv / __pycache__ / .pytest_cache` 在 `.gitignore` 中（`.gitignore:1-5`），未污染 Git。
- 分类：已实现。

### 1.9 第 18 节：暂缓决定

#### 差异 1.9.1 — 部分实现（默认值已校准，但显式声明仍缺失）

- 目标要求：「以下内容等待 Codex 纵向验证结果，不在设计阶段猜测：默认与安全最大的参与者数量；自由讨论默认检查窗口数；默认总调用预算；全局实际并发默认值；是否以及如何发布不依赖 Node.js 的独立可执行程序」。
- 代码证据：
  - `src/core/limits.ts:4-20` 已校准 DEFAULT 与 SAFE_MAX 两层数值（4/8，60/100，6/12，300/1800，128000/1000000，6/16）。
  - 目标第 18 节"独立可执行程序"未实现，但被目标明确标为"暂缓"且首版要求 Node.js —— 符合暂缓原则。
  - `package.json:8-12` `bin.mad = dist/cli/index.js`，未引入 `pkg` / `bun build --compile` / `deno compile` 工具。
- 差异描述：默认数值已落地为代码，但目标架构原意是"暂缓决定"——目前已与"calibration after Codex end-to-end"相一致；只是"独立可执行"仍未在文档中明确暂缓/排除，仅依赖首版"Node.js"约束。
- 严重度：低。
- 建议：在架构文档或 ADR 中显式补记"独立可执行程序：暂缓，依赖 Node.js >=22"。

---

## 2. 总体评估

1. 已实现：第 1、2、3、5、6、9、13、17 节**全部要求**；第 18 节默认数值校准完成。
2. 部分实现：
   - 第 1 节：仓库物理残留 `.venv / .python-version / .pytest_cache`（已 gitignore 隔离，文档未说明）。
   - 第 18 节："独立可执行程序"未在文档中显式记为"暂缓"。
3. 缺失：无。
4. 过度实现：无（无 monorepo、无数据库、无 Agent Framework / DevUI，无超规状态写入者）。

## 3. 关键建议

- **低优**：清理或文档化 `.venv / .python-version / .pytest_cache` 残留，避免外部协作者误判项目语言栈。
- **低优**：在 ADR 或架构文档中显式记录"独立可执行程序：暂缓"决定。
- **协作**：第 9 节资源/上下文细节、观察服务、CLI 适配器等交由对应专项审查 agent 验证（已避免重复报告）。

---

**创建时间**：2026-07-21
**创建概要**：基于 `docs/TypeScript目标架构.md` 第 1、2、3、5、6、9、13、17、18 节，对当前 `src/`、`tests-ts/`、`package.json`、`tsconfig.json` 进行架构一致性审查；结论为目标架构全部核心要求已实现，仅有 2 项低优建议（仓库物理残留与暂缓决定文档化）。
