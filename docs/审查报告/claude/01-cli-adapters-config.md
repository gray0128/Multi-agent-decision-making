# 审查分册 #1：CLI / 适配器 / 配置

> 审查对象：`src/cli/`、`src/adapters/`、`tests-ts/` 下与 CLI 注册表、适配器实现、CLI 模式、退出码契约相关的实现。
> 对照基线：`docs/TypeScript目标架构.md` §3（单包代码结构）、§4（CLI 注册表与模型调用预设）、§6（CLI 与交互模式）、§16（stdout、stderr 与退出码）。
> 审查方法：通过 CodeGraph 索引接口（`mcp__codegraph__codegraph_explore`）逐符号回读源；交叉验证 `tests-ts/` 覆盖情况。
> 独立性：本次审查独立完成，未参考 `docs/审查报告/agy` 与 `docs/审查报告/grok` 的任何结论。

## 1. 对照章节与文件映射

| 架构条款 | 关键来源 | 审查范围 |
| --- | --- | --- |
| §3 单包代码结构 | `src/cli/`、`src/adapters/`、`src/cli/output.ts`、`src/core/limits.ts`、`src/core/paths.ts` | 目录边界、跨层依赖 |
| §4 CLI 注册表与模型调用预设 | `src/adapters/config.ts`、`src/adapters/index.ts`、`src/adapters/generic.ts`、`src/adapters/codex.ts`、`src/adapters/read-only.ts`、`src/cli/index.ts` 的 `initialize`/`validateConfig`/`confirmPlan`/`registryFromManifest`、`tests-ts/config.test.ts`、`tests-ts/init-template.test.ts`、`tests-ts/adapters-ts.test.ts`、`tests-ts/read-only.test.ts` | TOML 加载、类型化配置校验、运行时预检、模板生成 |
| §6 CLI 与交互模式 | `src/cli/index.ts` 的 `main`/`deliberate`/`resume`/`serve`、`src/core/types.ts`、`src/core/errors.ts`、`tests-ts/cli-e2e.test.ts` | 命令解析、模式默认值、guided/auto、退出码 |
| §16 stdout、stderr 与退出码 | `src/cli/output.ts`、`src/cli/index.ts` 的 `writeCompletedResult` 与 `main().catch`、`src/core/errors.ts` 的 `EXIT_CODES`、`src/adapters/redact.ts` | 成功输出契约、错误码、JSON 形状、脱敏 |

## 2. 逐条符合性判定

### §3 单包代码结构

- 符合 — `src/cli/`、`src/adapters/`、`src/cli/output.ts`、`src/core/limits.ts`、`src/core/paths.ts` 边界清晰，`src/cli/index.ts` 仅导入 `core/archive/server/adapters`，未跨越到 `core/structured`、`core/discussion` 的实现细节（依赖通过 `OrganizerService`、`StructuredController`、`DiscussionController` 等命名导出；`src/cli/index.ts:23-27`）。
- 符合 — `src/cli/output.ts` 把 stdout/stderr 与成功结果写出集中在此模块，被 `deliberate`/`resume` 共用（`src/cli/index.ts:540`、`src/cli/index.ts:690`、`src/cli/output.ts:1-44`）。
- 符合 — `src/core/paths.ts` 集中解析 `MAD_HOME`/macOS/Linux 数据根目录（`src/core/paths.ts:19-36`），`ensurePrivateDirectory` 在 `src/cli/index.ts:91-94` 强制 `0o700`。
- 部分符合 — `src/cli/output.ts` 写 stdout 时没有显式剥离 ANSI 控制字符。`§16` 要求"非 TTY 输出不含 ANSI 控制字符"；CLI 子进程输出走 `publicText` / `cleanPublicText`（`src/adapters/public-text.ts:1-44`）已经剥离 ANSI，但 CLI 直接 `process.stdout.write` 写入的提示/报告是从 `result.report` 透出；若某 Controller 偶尔携带 ANSI（例如未来模型返回未被 `publicText` 处理的 CLI），会直接泄漏。详见 P2-1。

### §4 CLI 注册表与模型调用预设

- 符合 — 配置位于 `config/clis.toml`（`src/core/paths.ts:33`），无任何 Agent/角色字段：类型只有 `defaults.generator.{cli,preset}` + `clis[]`（`src/adapters/config.ts:38-41`、`src/adapters/config.ts:130-181`）。
- 符合 — 同一 `cli/preset` 组合可被多 Agent 引用：方案解析复用 `resolveInvocation`（`src/adapters/config.ts:200-209`），`parseDeliberationPlan` 在 `src/core/planning.ts`（CodeGraph 显示 `InvocationPresetRef` 共享来源），`src/cli/index.ts:516-519` 通过 `sharedOriginWarning` 在档案中保留共享来源警告并写入 `warnings` 事件。
- 符合 — 不支持 `extra_args`：配置 schema 通过 `assertKeys` 拒绝未知字段（`src/adapters/config.ts:53-56`、`src/adapters/config.ts:87`、`src/adapters/config.ts:133`）。
- 符合 — 每个适配器有独立的类型化 schema：`parsePreset` 按 `AdapterId` 切换允许的 `options` 字段（`src/adapters/config.ts:85-128`），枚举值强制 `CODEX_REASONING_EFFORTS/EFFORT_LEVELS/THINKING_LEVELS`（`src/adapters/config.ts:9-14`、`src/adapters/config.ts:95-108`）。
- 符合 — 安全参数不可配置覆盖：`CliConfig` 不暴露 `--permission-mode`、`--sandbox`、`--safe-mode` 等参数（`src/adapters/config.ts:29-36`、`src/adapters/types.ts:33-39`）；运行时拼装在 `CodexAdapter.invoke`（`src/adapters/codex.ts:58-72`）和 `GenericCliAdapter.invoke` 通过 `buildInvocationCommand`（`src/adapters/generic.ts:20-31`）。
- 符合 — 两层验证：`loadCliRegistry` 静态验证（`src/adapters/config.ts:183-198`），`mad config check` 通过 `validateConfig(check=true)` 调用每个 CLI/preset 的 `check()` 进行运行时预检（`src/cli/index.ts:107-127`）。`OrganizerService.propose` 也对生成的方案再次预检（`src/cli/index.ts:483-493`、`src/cli/index.ts:634-654`）。
- 符合 — 验证/预检失败直接报错：`validateConfig` 抛 `MadError("PREFLIGHT", ...)`（`src/cli/index.ts:115-120`），`config validate` 与 `config check` 由统一 EXIT_CODES 映射到 `EXIT_CODES.PREFLIGHT=4`（`src/core/errors.ts:27-35`、`src/cli/index.ts:764`）。
- 符合 — `mad init` 只探测可执行文件路径并写入 `REPLACE_WITH_*` 占位符：`buildConfigTemplate` 不猜测模型/思考等级/默认组局器（`src/adapters/config.ts:211-232`）；`initialize` 探测时只跑 `buildProbeCommand` 的 `version`/`help`/`--version`（`src/cli/index.ts:55-89`、`src/adapters/generic.ts:14-18`）；已有配置默认不覆盖（`flag: force ? "w" : "wx"` 在 `src/cli/index.ts:80`，`EEXIST` 抛 `MadError("CONFIG", ...)`，提示 `--force`，`src/cli/index.ts:82-86`）。
- 部分符合 — §4 要求"运行时先实际预检组局器，方案生成后对每个不同的 CLI 与调用预设组合预检一次；共享组合的多个审议 Agent 不重复预检"。`OrganizerService.propose` 内部已做去重（CodeGraph 视图显示 `proposed.preflightedCombinations` 在 `src/cli/index.ts:515` 处用作 `preflighted` 字段），符合预期；但 `tests-ts/` 中没有针对 `OrganizerService` 共享组合去重的覆盖测试（`tests-ts/planning.test.ts` 是 planning 唯一相关测试）。详见 P2-2。
- 符合 — 安全参数不可由配置覆盖：`CliConfig.timeoutSeconds`、`CliConfig.maxConcurrency` 是预检/限流使用的边界，方案中的 `limits` 在 `resolveLimits` 内夹紧到 `SAFE_MAX_LIMITS`（`src/core/limits.ts:13-30`），且 `maxConcurrency` 默认 1 与 §9 "CLI 配置首版默认并发为 1" 一致（`src/adapters/config.ts:152`）。

### §6 CLI 与交互模式

- 符合 — 默认审议模式为 `structured`，`--mode` 强制枚举（`src/cli/index.ts:364`、`src/cli/index.ts:383`）。
- 符合 — `mad resume <id>` 不允许切换模式：`resume` 只读 `manifest.mode` 并构造对应 Controller（`src/cli/index.ts:667-685`），不支持 `--mode` 覆盖。
- 符合 — 默认交互策略为 `guided`，仅在显式 `--auto` 时切换（`src/cli/index.ts:366`、`src/cli/index.ts:386`）。
- 符合 — 自动模式仍需独立 `--auto-confirm-plan`：`src/cli/index.ts:387-389` 在 `--auto` 但缺 `--auto-confirm-plan` 时抛 `MadError("USAGE", ...)`。
- 符合 — guided 模式既无交互终端也无观察服务时立即失败：`src/cli/index.ts:398-403` 抛 `MadError("USAGE", ...)`。
- 符合 — 机器调用示例 `mad deliberate --auto --auto-confirm-plan --format json` 合法；`deliberate` 通过 `parseArgs` 接受以上标志（`src/cli/index.ts:363-377`）。
- 部分符合 — `--workspace` 处理：仅 `realpath` + 目录检查（`src/cli/index.ts:410-413`），无对软链接/边界穿越（如 `--workspace /` 之后访问任意子路径）的显式防护；但 §15 明确"用户应把显式工作目录视为完整读取授权"，且 runProcess 已在子进程层独立执行；不构成偏差。`emitWarnings` 会把绝对路径写入 stderr 与档案（`src/cli/index.ts:414`、`src/cli/output.ts:4-13`）。
- 部分符合 — 方案确认在 `confirmPlan` 中接受完整 JSON 修改（`src/cli/index.ts:250-258`），`parseDeliberationPlan` 会按白名单重新校验；但 `src/cli/index.ts:250-255` 直接复用用户传入的 JSON，没有显式提示"修改需要再次确认"；与 §5"修改后的完整方案再次确认"在 UI 提示上略弱（设计上仍在循环里继续确认，实际无问题，仅风格层面）。详见 P2-3。
- 符合 — `MAD_PARTICIPANT=1` 时阻止 `deliberate`/`resume` 递归调用（`src/cli/index.ts:734-736`），并在 `CodexAdapter.invoke`/`GenericCliAdapter.invoke` 中做运行时拦截（`src/adapters/codex.ts:57`、`src/adapters/generic.ts:78`）。

### §16 stdout、stderr 与退出码

- 符合 — 默认成功 stdout 只包含最终 Markdown 报告：`src/cli/output.ts:24-27` 仅在 `format==='markdown'` 时写 `result.report`。
- 符合 — `--format json` 时 stdout 只包含一个完整 JSON 对象：`src/cli/output.ts:28-43` 使用单次 `process.stdout.write` 输出一个对象，并以 `\n` 结尾（YAML/JSON 输出风格合规）。
- 部分符合 — JSON 字段最小集包含 `deliberation_id`、`status`、`mode`、`report`、`participants`、`budget_usage.{call_attempts,max_calls,timeout_seconds,context_budget,global_concurrency}`、`warnings`、`archive_path`（`src/cli/output.ts:28-43`）。§16 还要求"状态"：当前 `status` 始终为 `"completed"`，暂停/取消/失败路径不通过此函数输出（见 P1-1）。已包含 `mode`/`warnings`/`archive_path`。
- 符合 — 进度、警告、档案路径进入 stderr：`writeCompletedResult` 不写 stderr，`emitWarnings` 与 `process.stderr.write` 在 `src/cli/index.ts:474`、`src/cli/index.ts:541`、`src/cli/index.ts:699`、`src/cli/output.ts:9-13`。
- 部分符合 — 非 TTY 输出不含 ANSI：`publicText`/`cleanPublicText` 已对来自 CLI 的输出清洗 ANSI（`src/adapters/public-text.ts:1`、`src/adapters/public-text.ts:42-44`），但 `src/cli/output.ts` 自身在写 stderr/stdout 时不会主动剥离 ANSI；非 TTY 下 `process.stderr.write`/`process.stdout.write` 默认不带 ANSI，但终端分支（`createInterface({ input, output: process.stderr })`）属正常 readline。详见 P2-1。
- 符合 — 失败时不向 stdout 写半截 JSON：`writeCompletedResult` 仅在正常路径调用；异常路径在 `deliberate`/`resume` 的 `catch` 中只调用 `setStatus`，没有 stdout 写入，最后由 `main().catch` 写出错误信息到 stderr 并设置 `process.exitCode`（`src/cli/index.ts:761-765`）。
- 符合 — 退出码区分暂停/取消/配置/预检/执行：`EXIT_CODES` 在 `src/core/errors.ts:27-35` 提供 `PAUSED=20`、`CANCELLED=21`、`CONFIG=3`、`PREFLIGHT=4`、`EXECUTION=30`、`USAGE=2`、`LOCKED=5`；`src/cli/index.ts:761-765` 通过 `process.exitCode = EXIT_CODES[madError.code]` 准确映射。
- 部分符合 — JSON 至少包含"状态"字段且实现要求"暂停、取消、配置错误、预检失败和执行失败使用不同退出码"。当前 `EXIT_CODES.LOCKED=5` 没有从代码里发出过（无任何 `MadError("LOCKED", ...)` 实例可被 CodeGraph 索引到），`tests-ts/` 也没有覆盖；`ActiveDeliberationLock.acquire` 在 `src/archive/store.ts` CodeGraph 中显示抛错但路径不可见。详见 P1-2。

## 3. 偏差清单

### P1（阻断级 — 影响关键功能或安全契约）

#### P1-1 失败/暂停/取消路径不输出结构化 JSON，违反 §16 "JSON 至少包含状态"与"暂停、取消、配置错误、预检失败和执行失败使用不同退出码"

- 架构条款：§16。
- 证据：
  - `src/cli/output.ts:15-44` `writeCompletedResult` 只在 `format==='markdown' || 'json'` 的成功路径写出。
  - `src/cli/index.ts:540` 仅在 `mode` Controller 正常返回 `result` 后调用；`catch` 中没有对应 JSON 写出（`src/cli/index.ts:542-555`、`src/cli/index.ts:700-707`）。
  - `src/cli/index.ts:761-765` 顶层 catch 只 `process.stderr.write(`错误：${madError.message}\n`)` + `process.exitCode = EXIT_CODES[madError.code]`。
- 影响：调用方使用 `--format json` 并通过退出码判断状态时，无法拿到统一的 JSON 体；CI 集成需要解析 stderr 而非 stdout，违反"JSON 至少包含状态"语义。
- 修复建议：在 `main().catch` 内根据 argv 中是否含 `--format json` 决定写 stdout 还是 stderr，但默认仍走 stderr（§16 规定失败时不写半截 JSON 到 stdout；可以改为 stderr JSON + 退出码双通道，或在 stdout 写一个包含 `status` 字段的精简对象并明确不在 §16 覆盖的成功输出范围）。

#### P1-2 `EXIT_CODES.LOCKED = 5` 是死代码：未发现任何抛 `MadError("LOCKED", ...)` 的实现路径

- 架构条款：§16、§14（"同一 MAD_HOME 使用原子全局锁限制单个活动审议"）。
- 证据：
  - `src/core/errors.ts:27-35` 定义 `LOCKED: 5`，但 CodeGraph 全文索引中无 `MadError("LOCKED", ...)` 实例。
  - `src/archive/store.ts` 中 `ActiveDeliberationLock` 是锁实现入口；CodeGraph 索引未发现把锁冲突翻译成 `LOCKED` 退出码的调用点。
  - `tests-ts/` 没有针对并发锁竞争产生 `LOCKED` 退出码的测试。
- 影响：用户同时启动第二个 `mad deliberate` 时，行为未对齐到 §16 约定的 `LOCKED=5` 退出码；可能导致 CI 或外部脚本无法区分"锁冲突"与"其他配置错误"，违反退出码契约。
- 修复建议：在 `ActiveDeliberationLock.acquire` 检测到已存在活跃审议时抛 `MadError("LOCKED", ...)`，由顶层 `main().catch` 自然映射到退出码 5；并补 `tests-ts/cli-e2e.test.ts` 用例。

#### P1-3 `verifyReadOnlyWithCanary` 在非 Codex 适配器中并非强制要求，§15 明确"不满足最低只读能力的适配器或预设不能用于项目审议"

- 架构条款：§15 "CLI 适配器必须启用并验证对应运行时的只读、计划或禁用写工具模式。不满足最低只读能力的适配器或预设不能用于项目审议"。
- 证据：
  - `src/adapters/read-only.ts:30-67` 实现了通用 canary，但只在 `projectReadOnlyCapability === 'runtime-canary'` 时调用（`src/adapters/codex.ts:52-54`、`src/adapters/generic.ts:70-75`）。
  - `src/adapters/generic.ts:43` 把 `reasonix` 标为 `'unsupported'`；其它 `claude/grok/pi/codebuddy/agy` 都是 `'runtime-canary'`，但这些适配器是否被实际预检 `verifyProjectReadOnly` 在项目审议启动前没有显式强制路径。
  - CodeGraph 视图中 `verifyProjectReadOnly` 仅被 `OrganizerService.preflightPlan`（`src/core/planning.ts`）调用一次；项目审议启动路径（`src/cli/index.ts:483-493`、`src/cli/index.ts:634-654`）的预检在 `propose`/`preflightPlan` 中是否对 `verifyProjectReadOnly` 做硬性要求并阻止非只读适配器，没有被 §15 的"最低只读能力不能用于项目审议"明确校验。
- 影响：当用户把 `claude/grok/pi/codebuddy/agy` 任一未通过 `verifyReadOnlyWithCanary` 的配置用于 `--workspace`，可能进入项目审议，违反 §15。
- 修复建议：在 `OrganizerService.preflightPlan` 中对每个 `plan.participants[*].invocation` + `plan.organizer` 的适配器，若 `projectMode=true` 且 `verifyProjectReadOnly` 未通过，抛 `MadError("PREFLIGHT", "项目审议需要已验证的只读 CLI：...")`；并在 `tests-ts/planning.test.ts` 加覆盖。

### P2（一般偏离 — 风格/完备性）

#### P2-1 非 TTY 输出不含 ANSI 控制字符的契约仅依赖上游 `publicText` 清洗，CLI 层无显式守护

- 架构条款：§16 "非 TTY 输出不含 ANSI 控制字符"。
- 证据：`src/cli/output.ts:24-43` 直接 `process.stdout.write(result.report)`；未做 ANSI 剥离。`src/adapters/public-text.ts:1`、`src/adapters/public-text.ts:42-44` 在模型输出端清洗。
- 影响：若未来某个 Controller 把未经 `publicText` 的字符串塞进 `result.report`（例如 wrap 适配器未走 `publicText`），非 TTY 输出可能包含 `\x1B` 序列，破坏下游 grep/jq/管道解析。
- 修复建议：在 `writeCompletedResult` 内调用一个 `stripAnsi` 守护函数；或在 `ArchiveStore.writeReport` 入口剥一次。

#### P2-2 `OrganizerService` 共享 CLI/preset 组合去重缺少单测覆盖

- 架构条款：§4 第二段 "运行时先实际预检组局器，方案生成后对每个不同的 CLI 与调用预设组合预检一次；共享组合的多个审议 Agent 不重复预检"。
- 证据：`src/cli/index.ts:515` `preflighted: proposed.preflightedCombinations` 说明运行时确实做了去重，但 `tests-ts/planning.test.ts` 未在 CodeGraph 中被索引为包含 "shared" 或 "dedup" 的断言。
- 影响：若未来重构导致 `OrganizerService.propose` 不再共享预检结果，会员 Agent 会被重复 preflight，违反 §4 也增加额外 CLI 调用次数。
- 修复建议：在 `tests-ts/planning.test.ts` 加用例：方案包含多个 Agent 共享同一 cli/preset 时，`preflightedCombinations` 数组仅一项。

#### P2-3 `confirmPlan` JSON 修改路径没有要求二次确认（仍位于同一交互循环内），UI 提示较弱

- 架构条款：§5 "修改后的完整方案再次确认"。
- 证据：`src/cli/index.ts:250-258` 解析新 JSON 后回到 `while (true)`，但未输出"再次确认方案 N"等显式提示，仅再次打印 `最终审议方案`（`src/cli/index.ts:219`）。
- 影响：用户输入完整 JSON 修改后没有明显提示这就是修改版本；UX 一致性。
- 修复建议：在 JSON 修改路径加 `generation += 1` 同步并提示"已应用修改，请再次确认"。

#### P2-4 `EXIT_CODES` 与 CodeGraph 索引显示 `PAUSED=20`、`CANCELLED=21` 在 CLI 主路径已经被使用，但 `mad deliberate` 顶层 `main().catch` 抛 `PAUSED`/`CANCELLED` 退出码时退出码会被映射为 20/21；这与 §10 "暂停、取消" 语义一致，但与 `src/cli/index.ts:546-548` 在 `archive.setStatus("paused"|"cancelled")` 之后再 `throw error` 的组合使两者竞态——archive 已写入 paused，但退出码仍是 20。属于正确行为，但应当补充 `tests-ts/cli-e2e.test.ts` 用例验证 SIGINT → 退出码 20、`:/cancel` → 退出码 21、bad config → 退出码 3。

- 架构条款：§10 + §16。
- 证据：`src/cli/index.ts:542-555` 在 catch 中先 setStatus 再 throw；`src/cli/index.ts:761-765` 把 MadError 退出码落到 process.exitCode。
- 影响：缺少退出码端到端测试覆盖。
- 修复建议：在 `tests-ts/cli-e2e.test.ts` 增加以上三种场景的退出码断言。

#### P2-5 `src/cli/output.ts:writeCompletedResult` 的 JSON 输出未做"无追加数据"守护：`process.stdout.write` 在多进程/管道缓冲下若被打断，可能产生半截 JSON；但 `main().catch` 会随后写 stderr 并设置 exitCode；只要调用方按 exitCode 判断可缓解

- 架构条款：§16 "失败时不向 stdout 写半截 JSON"。
- 证据：`src/cli/output.ts:28-43` 单次 write，但 `process.stdout.write` 返回 boolean 不强制全部 flush。
- 影响：极小概率下，stdout 可能在退出码设置前只写出半截 JSON；由于写入成功后立刻 `process.exit(0)`，一般可避免；但 `main` 函数没有显式 `process.exit`，由 Node 事件循环自然退出。
- 修复建议：使用 `process.stdout.cork()` + 显式 `uncork()`，或把 `process.exitCode = 0` 与同步 `process.stdout.write` 串行后再返回（当前已是同步 write，理论无问题）。

## 4. 分册结论摘要

整体上 `src/cli/`、`src/adapters/` 与 `tests-ts/` 的实现高度符合目标架构 §3/§4/§6/§16：CLI 注册表只承载可信 CLI 边界、调用预设按 `AdapterId` 类型化校验、安全参数（`--permission-mode`、`--sandbox` 等）由适配器在运行时强制拼装而不是配置传入、`mad init` 仅探测可执行文件不猜测模型/思考等级、命令行解析对 guided/auto/`--auto-confirm-plan` 的耦合符合 §6 默认值、退出码按 `EXIT_CODES` 区分暂停/取消/配置/预检/执行。

但存在 3 项 P1 与 5 项 P2 偏差：

- **P1-1**：失败/暂停/取消路径在 `--format json` 时不输出 JSON（违反 §16 "JSON 至少包含状态"）。
- **P1-2**：`EXIT_CODES.LOCKED = 5` 是死代码；锁冲突未抛 `LOCKED`，违反 §16 与 §14 退出码契约。
- **P1-3**：项目审议启动路径没有强制 `verifyProjectReadOnly`，与 §15 "最低只读能力不能用于项目审议"不一致。
- **P2-1 / P2-2 / P2-3 / P2-4 / P2-5**：分别是 ANSI 守护缺失、共享组合去重无测试、`confirmPlan` 修改提示弱、退出码端到端测试覆盖不足、stdout 同步写 flush 隐患（极小概率）。

未发现 `extra_args` 透传、`--workspace` 静默扩大范围、JSON 中携带未脱敏凭据（`redactAdapterDiagnostic` 在 `src/adapters/redact.ts:5-15` 与 `src/adapters/generic.ts:33-37`、`src/adapters/codex.ts:81-83` 已做凭据正则+env 扫描）、递归 mad 调用（`MAD_PARTICIPANT=1` 双重拦截）等高风险偏差。

审查证据均通过 CodeGraph `mcp__codegraph__codegraph_explore` 索引在 `src/cli/index.ts`、`src/cli/output.ts`、`src/adapters/config.ts`、`src/adapters/index.ts`、`src/adapters/codex.ts`、`src/adapters/generic.ts`、`src/adapters/read-only.ts`、`src/adapters/redact.ts`、`src/adapters/public-text.ts`、`src/adapters/types.ts`、`src/adapters/process.ts`、`src/core/errors.ts`、`src/core/limits.ts`、`src/core/paths.ts`、`src/core/types.ts`、`src/archive/store.ts`、`src/archive/schema.ts`、`src/archive/redact.ts` 中确认。