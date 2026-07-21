# CLI 适配器与注册表审查报告

> 审查日期：2026-07-21
> 审查基线：当前工作区 `HEAD`（`85f97af`）
> 对照规范：[TypeScript CLI 与审议观察页目标架构](../../../TypeScript目标架构.md) 第 4、6 节
> 审查范围：CLI 注册表（`clis.toml`）、适配器 schema、`extra_args` 禁止、调用预设、方案约束、两层验证、`mad init`、失败行为、子命令与七个适配器
> 审查者：CLI 适配器与注册表视角

## 1. 审查对象与证据

- 目标文档：`docs/TypeScript目标架构.md` 第 4 节（CLI 注册表与模型调用预设）与第 6 节（CLI 与交互模式）。
- 关键源码：
  - `src/adapters/index.ts`：适配器工厂
  - `src/adapters/config.ts`：注册表 schema、解析、`buildConfigTemplate`
  - `src/adapters/generic.ts`、`src/adapters/codex.ts`：类型化调用命令与预检
  - `src/adapters/process.ts`：进程封装（无任何参数透传接口）
  - `src/cli/index.ts`：`mad init` / `mad config validate` / `mad config check` / `deliberate` / `resume` 入口
  - `src/core/planning.ts`：方案解析、`OrganizerService.propose`、`preflightPlan`
  - `src/core/paths.ts`：注册表路径 `MAD_HOME/config/clis.toml`
- 关键测试：
  - `tests-ts/config.test.ts`：注册表 schema、`extra_args` 拒绝、占位符拒绝、重复预设拒绝
  - `tests-ts/planning.test.ts`：方案字段白名单、共享 CLI/preset 预检只跑一次、读只支持必检
  - `tests-ts/adapters-ts.test.ts`：七个适配器的只读/非持久边界、推理选项绑定
  - `tests-ts/init-template.test.ts`：模板不猜测默认组局器与模型
- 审查方式：以第 4 节十项约束为主线，逐条对照代码与测试，给出「已实现 / 部分实现 / 缺失 / 过度实现」判定与证据。

## 2. 第 4 节逐项审查

### 2.1 长期配置文件为 `clis.toml`，不预设长期 Agent 或角色

**目标要求**：第 4 节首段：「长期配置文件为 `config/clis.toml`。它只保存可信 CLI 执行边界，不预设长期 Agent 或角色。」

**代码证据**：
- 路径生成：`src/core/paths.ts:32` `config: join(home, "config", "clis.toml")`。
- 注册表类型：`src/adapters/config.ts:37-40` `CliRegistry` 仅包含 `defaults.generator`、`clis`；`CliConfig` 包含 `id/adapter/executable/timeoutSeconds/maxConcurrency/presets`，无任何 Agent、角色或会话字段。
- 解析器严格白名单：`src/adapters/config.ts:122` `assertKeys(raw, ["id", "adapter", "executable", "timeout_seconds", "max_concurrency", "presets"], path)`；预设白名单 `src/adapters/config.ts:80` `assertKeys(raw, ["id", "model", "context_budget", "options"], cliPath)`；预设选项白名单 `src/adapters/config.ts:82-85`。
- 全仓库检索 `agents` / `role` / `长期`：`src/` 下无任何长期 Agent 或角色持久化字段（`grep -rEn "agents\.toml|长期" src/` 命中 0 行）。

**判定**：已实现。
**严重度**：—

### 2.2 每个适配器定义自己的类型化配置 schema；禁止配置覆盖只读、审批、工具限制、输出格式、工作目录等安全参数

**目标要求**：第 4 节末段「每个适配器定义自己的类型化配置 schema，并禁止配置覆盖只读、审批、工具限制、输出格式和工作目录等安全参数。」

**代码证据**：
- 适配器配置字段白名单仅包含：`id / adapter / executable / timeout_seconds / max_concurrency / presets`（`src/adapters/config.ts:122`、`parseCli`）。
- 选项按适配器硬编码：`src/adapters/config.ts:82-85` —— 仅允许 `reasoning_effort`（codex）、`effort`（claude、grok）、`thinking`（pi），其它选项一律 `assertKeys` 拒绝。
- 枚举闭包：`CODEX_REASONING_EFFORTS` / `EFFORT_LEVELS` / `THINKING_LEVELS`（`src/adapters/config.ts:8-13`），任意越界即抛 `CONFIG` 错误。
- `executable`、`timeout_seconds`、`max_concurrency` 没有别名路径；不允许 `--permission-mode`、`--tools`、`--output-format`、`--cwd`、`--safe-mode` 等出现在 TOML 中（白名单 + 通用 reject 机制）。
- 适配器各自构建自己的安全调用命令：`src/adapters/codex.ts:52-66` 强制 `--sandbox read-only --ephemeral`；`src/adapters/generic.ts:21-26` 强制 `--permission-mode plan --no-session-persistence --safe-mode`（claude）、`--permission-mode plan --no-subagents --no-memory`（grok）、`--no-approve --no-extensions --tools read,grep,find,ls`（pi）、`--permission-mode plan --strict-mcp-config`（codebuddy）、`--mode plan --sandbox`（agy）。
- 测试覆盖：`tests-ts/adapters-ts.test.ts:21-31` 用 `it.each` 验证 5 个适配器各自硬编码 `plan` / `no-session-persistence` 等只读与非持久标志。

**判定**：已实现。安全参数没有可配置路径；任何越权字段一律抛 `CONFIG`。
**严重度**：—

### 2.3 不支持 `extra_args` 等原始参数透传

**目标要求**：第 4 节「不支持 `extra_args` 等原始参数透传。」

**代码证据**：
- 全仓库检索 `extra_args` / `extraArgs`：
  - `tests-ts/config.test.ts:35-37` 仅作为反例：`unsafe.clis[0]!.extra_args = ["--dangerously-bypass-approvals-and-sandbox"]; expect(() => parseCliRegistry(unsafe)).toThrowError(/未知字段：extra_args/)`。
  - 其它位置 0 命中。
- `parseCli` 与 `parsePreset` 的 `assertKeys` 拒绝任何未列入白名单的键，包括任何形式的 `extra_args / args / flags / options / raw`。
- 调用层 `runProcess` 的入参只有 `args: readonly string[]`（`src/adapters/process.ts:23-25`），且 `args` 全部由 `buildInvocationCommand` 生成，不接受来自注册表或方案的任何附加串。

**判定**：已实现。配置层与调用层均无原始参数透传机制。
**严重度**：—

### 2.4 模型调用预设是可信组合；同一模型允许多个预设

**目标要求**：第 4 节「模型调用预设是模型与思考等级等推理设置的可信组合。同一模型可以拥有多个预设。」

**代码证据**：
- `InvocationPreset` 类型（`src/adapters/config.ts:21-26`）仅由 `id / model / contextBudget / options` 组成，`options` 又只允许三个枚举字段之一。
- 每个 CLI 的 `presets` 数组独立解析、按 `id` 去重（`src/adapters/config.ts:131-135`）：`for (const preset of presets) { if (presetIds.has(preset.id)) throw ... }`，不同预设的 `model` 允许相同（无跨预设去重）。
- 注册表 schema 不约束同一 `model` 不能重复出现，因此同一模型可绑定多个不同 `id` 的预设。
- 推理选项枚举按适配器差异化映射：`src/adapters/config.ts:82-106` 给 `reasoning_effort` / `effort` / `thinking` 三套不同枚举，并白名单拒绝其它键。
- 测试：`tests-ts/config.test.ts:34-38` 验证 `extra_args` 被拒绝；`tests-ts/config.test.ts:46-50` 验证同一预设数组内 `id` 不允许重复（与模型重复无冲突）。

**判定**：已实现。允许同一模型多预设；推理选项闭包严格。
**严重度**：—

### 2.5 审议方案只能引用 CLI 配置 + 调用预设；禁止裸模型名、可执行路径、CLI 参数

**目标要求**：第 4 节「审议方案只能引用 `CLI 配置 + 调用预设`，不能携带裸模型名、任意推理设置、可执行路径或 CLI 参数。」

**代码证据**：
- 方案解析白名单：`src/core/planning.ts:57-60` 顶层键仅为 `participants / report_agent_id`（free 模式多 `moderator_agent_id`）；参与者白名单：`src/core/planning.ts:69` `keysOnly(participant, ["id", "cli", "preset", "role"], path)`。
- 引用解析：`src/core/planning.ts:73-74` `resolveInvocation(options.registry, cli, preset)` 直接校验 cli/preset 必须存在于注册表，不存在即抛 `CONFIG`。
- 测试断言：`tests-ts/planning.test.ts:49-58` 显式验证携带 `model` 字段的方案被 `keysOnly` 拒绝（`/禁止字段：model/`）。
- 推理设置只来自 `preset` —— 方案侧没有暴露 `reasoning_effort / effort / thinking` 入口；executable / args / permission-mode / tools 同样无入口。

**判定**：已实现。
**严重度**：—

### 2.6 两层验证：加载配置时静态验证；运行时对每个不同 CLI+preset 组合预检一次；共享组合不重复

**目标要求**：第 4 节验证分两层，方案生成后对每个不同的 CLI 与调用预设组合预检一次；共享组合的多个审议 Agent 不重复预检。

**代码证据**：
- 静态层（加载时）：`src/adapters/config.ts:172-187` `loadCliRegistry` 调用 `parseCliRegistry`，对所有键、类型、枚举、ID 模式、重复预设、占位符、`adapter` 合法性、`defaults.generator` 引用一致性进行白名单与闭包校验。
- 运行时预检：
  - 组局器在 `propose` 中先单独预检：`src/core/planning.ts:138` `requireReady(generatorAdapter, ...)`。
  - 方案内组合去重预检：`src/core/planning.ts:186-202`
    ```ts
    for (const participant of plan.participants) {
      const key = `${participant.invocation.cli}/${participant.invocation.preset}`;
      if (!combinations.has(key)) {
        const resolved = resolveInvocation(this.registry, participant.invocation.cli, participant.invocation.preset);
        const adapter = this.adapterFactory(resolved.cli, resolved.preset);
        if (projectMode && !adapter.supportsProjectReadOnly) throw new MadError("PREFLIGHT", ...);
        combinations.set(key, { adapter, cliId: resolved.cli.id, maximum: resolved.cli.maxConcurrency });
      }
    }
    ```
    `combinations` 起到「共享组合不重复」的去重器作用；同 key 第二次出现直接跳过 `factory`/`check`。
  - 并发调度遵守 CLI 配置级限流：`src/core/planning.ts:199-201` `new InvocationScheduler(plan.limits.globalConcurrency ?? 6)` + `cliId, value.maximum`。
- 测试覆盖：
  - `tests-ts/planning.test.ts:60-81` `preflights each unique invocation combination only once` 显式断言 `adapter.check` 仅被调用 2 次（组局器 1 + 唯一组合 1）。
  - `tests-ts/planning.test.ts:83-101` `blocks an adapter without proven read-only mode` 断言 `reasonix` 在项目模式下被拦截。

**判定**：已实现。预检层、共享去重、CLI 配置级限流、`PREFLIGHT` 错误码均齐备。
**严重度**：—

### 2.7 `mad init` 只探测已安装 CLI、生成骨架、不猜测模型或默认组局器；已有配置默认不覆盖

**目标要求**：第 4 节末段：「`mad init` 只探测已安装 CLI 和可执行路径，生成带适配器选项说明的配置骨架，不猜测模型、思考等级或默认组局器。已有配置默认不覆盖；用户显式要求时才重建模板。」

**代码证据**：
- 探测逻辑：`src/cli/index.ts:62-74` 并发 `findExecutable(adapter)` + `runProcess(executable, probe, ...)`，仅保留 `exitCode === 0` 的适配器；不联网、不读现有注册表、不调用任何模型。
- 模板生成：
  - `src/adapters/config.ts:200-221` `buildConfigTemplate` 头部硬编码 `cli = "REPLACE_WITH_CLI_ID"`、`preset = "REPLACE_WITH_PRESET_ID"`，模型占位符 `REPLACE_WITH_MODEL_ID`。
  - 每个被探测到的 CLI 生成一节，模型强制 `REPLACE_WITH_MODEL_ID`，无默认值。
  - 思考等级说明以注释形式写出（`# reasoning_effort = "..."`），不预设实际值。
- 不覆盖默认：`src/cli/index.ts:79` `flag: force ? "w" : "wx"`；`src/cli/index.ts:81-84` `EEXIST` 时显式抛错提示 `--force`。
- 测试：
  - `tests-ts/init-template.test.ts:6-13` 断言模板不含真实默认组局器/模型，包含 `REPLACE_WITH_CLI_ID / REPLACE_WITH_MODEL_ID`，并且 `parseCliRegistry(parsed)` 必然抛错（即「骨架本身必须由人补全」）。
  - `tests-ts/init-template.test.ts:15-18` 验证未安装任何 CLI 时仍生成可编辑骨架（`clis = []`）。

**判定**：已实现。探测/模板生成/默认不覆盖三条全部满足。
**严重度**：—

### 2.8 验证或预检失败阻止启动，不自动替换

**目标要求**：第 4 节末段「任何验证或预检失败都阻止审议启动，不自动替换 CLI、模型或思考等级。」

**代码证据**：
- 静态验证：`parseCliRegistry` 中任意 `MadError("CONFIG", ...)` 都向上抛出，由 `loadCliRegistry` 透传至调用方，无 catch 静默替换。
- 运行时预检：`src/core/planning.ts:205-209` `requireReady` 在 `result.ready === false` 时抛 `MadError("PREFLIGHT", ...)`；`src/core/planning.ts:193-195` 项目模式下 `!adapter.supportsProjectReadOnly` 抛 `PREFLIGHT`。
- `mad config check` 失败行为：`src/cli/index.ts:111-119` 任一组合 `check` 返回 `ready: false` 即抛 `MadError("PREFLIGHT", ...)`，由 `main` 的 `catch` 走到 `EXIT_CODES.PREFLIGHT`（`src/cli/index.ts:786-787`），不会替换为其它 CLI/预设。
- `deliberate` 启动路径：`src/cli/index.ts:480-490` `propose` 抛错即中止，CLI 入口 `parseArgs({ strict: true })` 不接受未声明标志。
- 组局器生成失败（auto 模式）：`src/core/planning.ts:160-180` 仅在白名单内重试 schema 解析，仍失败才抛 `EXECUTION`；不替换 CLI、不替换预设、不替换默认组局器。

**判定**：已实现。预检/校验失败一律抛错，无 fallback。
**严重度**：—

### 2.9 `mad config validate` 与 `mad config check`：静态验证 vs 实际预检

**目标要求**：第 4 节末段「配置通过 `mad config validate` 静态验证，通过 `mad config check` 实际预检。」

**代码证据**：
- 子命令分发：`src/cli/index.ts:765-768` `command === "config" && (argv[1] === "validate" || argv[1] === "check") && argv.length === 2`，`argv.length === 2` 防多余参数，限制 `config` 只接这两个二级命令。
- 统一入口：`src/cli/index.ts:106-126` `validateConfig(check)`：
  - 始终先 `loadCliRegistry(paths.config)`，即静态 schema 校验（白名单 + 枚举 + 引用）。
  - `check === false`：只输出 `配置有效：N 个 CLI；默认组局器 ...`，不调用任何 CLI。
  - `check === true`：遍历 `registry.clis.flatMap(cli => cli.presets)` 对每个组合调用 `createAdapter(...).check(process.cwd())`，任一失败抛 `PREFLIGHT`。
- 帮助文本同步：`src/cli/index.ts:43-44` `mad config validate` / `mad config check` 出现在 `HELP`。
- 测试：`tests-ts/cli-e2e.test.ts:100` 用一个 `broken = true\n` 的 TOML 触发加载失败（验证静态层覆盖），但本子命令本身由 `validateConfig` 直接串联两个层，未单独断言。静态层覆盖已由 `tests-ts/config.test.ts` 五个用例覆盖；预检层覆盖由 `tests-ts/adapters-ts.test.ts` 间接覆盖。

**判定**：已实现。子命令存在、行为分级、错误码区分（CONFIG vs PREFLIGHT）。
**严重度**：—

### 2.10 七个适配器：Codex、Claude、Reasonix、Grok、Pi、CodeBuddy、agy

**目标要求**：第 4 节架构图与第 2 节总体结构：「Codex / Claude / Reasonix / Grok / Pi / CodeBuddy / agy」。

**代码证据**：
- ID 集合：`src/adapters/config.ts:5` `ADAPTER_IDS = ["codex", "claude", "reasonix", "grok", "pi", "codebuddy", "agy"] as const` —— 七个全部包含。
- 工厂：`src/adapters/index.ts:7-21` `createAdapter` switch 中 `codex` 走 `CodexAdapter`，其余 6 个走 `GenericCliAdapter`；`default` 抛 `CONFIG`。
- 类型化调用命令：
  - `src/adapters/generic.ts:18-29` `buildInvocationCommand` 覆盖 claude/reasonix/grok/pi/codebuddy/agy 六个 case，每个 case 各自只读 / 非会话 / 工具白名单参数。
  - `src/adapters/codex.ts:50-73` `CodexAdapter.invoke` 单独强制 `--sandbox read-only --ephemeral`。
- 探测命令：`src/adapters/generic.ts:12-16` `buildProbeCommand` 给 reasonix 与 agy 单独指定 `version` / `help`，其它统一 `--version`。
- 唯一公开适配器类型也含七个：`src/core/types.ts:54` `InvocationConfigSnapshot.adapter` 联合类型。

**判定**：已实现。七个适配器 ID 全在册，注册表 schema 与工厂分支同步。
**严重度**：—

## 3. 第 6 节（CLI 与交互模式）关联检查

> 第 6 节本身聚焦 `mad deliberate` / `mad resume` 行为；与第 4 节重叠的是「CLI 子命令必须存在」、「运行时预检失败不替换」、「`mad init` 不替换既有配置」。下面仅交叉验证相关项，避免重复其他 agent 章节。

### 3.1 `mad init [--force]` / `mad config validate` / `mad config check` / `mad resume ID` 在 CLI 中存在

**代码证据**：
- 帮助：`src/cli/index.ts:39-52` 完整列出 `mad init [--force]` / `mad config validate` / `mad config check` / `mad deliberate` / `mad resume` / `mad serve`。
- 分发：`src/cli/index.ts:760-768` 顺序处理 `init` / `config validate|check`；`deliberate` / `resume` / `serve` 在 769-779。
- 未知命令：`src/cli/index.ts:781` `未知命令：...` 抛 `USAGE`。

**判定**：已实现。
**严重度**：—

### 3.2 默认模式 / `--mode structured|free` / `--auto-confirm-plan` 必填关系

**代码证据**：`src/cli/index.ts:357-388`
- `mode` 默认 `structured`（`default: "structured"`）。
- `--auto` 隐含 `interaction = "auto"`，但缺 `--auto-confirm-plan` 即抛 `USAGE`（`src/cli/index.ts:386-388`）。
- `--auto-confirm-plan` 与 `--auto` 绑定，未提供 `--auto` 时只用于 guided 但已确认终端/观察服务在线的场景（`src/cli/index.ts:400-402`）。

**判定**：已实现（与第 6 节机器调用示例一致）。
**严重度**：—

### 3.3 无交互终端时 guided 必须立即失败

**代码证据**：`src/cli/index.ts:395-402`
```ts
const terminalAvailable = Boolean(process.stdin.isTTY && process.stderr.isTTY);
const observerAvailable = await observerIsOnline(paths.runtime);
if (interaction === "guided" && !terminalAvailable && !observerAvailable) {
  throw new MadError("USAGE", "guided 模式需要交互终端或在线观察服务；当前尚无可用交互通道");
}
if (interaction === "guided" && !terminalAvailable && !parsed.values["auto-confirm-plan"]) {
  throw new MadError("USAGE", "无交互终端时必须用 --auto-confirm-plan 接受首次有效组局方案");
}
```
不进入无限等待，立即抛错。

**判定**：已实现。
**严重度**：—

### 3.4 预检失败时审议不启动、不替换

**代码证据**：`src/cli/index.ts:480-490` `propose` 失败直接抛出 `PREFLIGHT`（由 `planning.ts` 抛出），`deliberate` 主流程未捕获此错误，会走到 `src/cli/index.ts:559-572` 的 catch 分支把状态写为 `failed`（若 archive 已创建），最终由 `main` 写到 stderr 并以 `EXIT_CODES.PREFLIGHT` 退出（`src/core/errors.ts` 中定义）。期间不存在任何「改用其它 CLI / 预设 / 思考等级」的回退逻辑。

**判定**：已实现。
**严重度**：—

## 4. 综合判定与遗留问题

| 序号 | 第 4/6 节要求 | 状态 | 主要证据 |
| ---- | -------------- | ---- | -------- |
| 1 | `clis.toml` 长期配置、无长期 Agent/角色 | 已实现 | `paths.ts:32`、`config.ts:122`、`parseCli` 白名单 |
| 2 | 适配器类型化 schema；禁止覆盖安全参数 | 已实现 | `config.ts:80-85` 选项白名单、`codex.ts`/`generic.ts` 硬编码只读 |
| 3 | 禁止 `extra_args` 等透传 | 已实现 | 全仓 0 业务命中；唯一引用是反向测试 `config.test.ts:35-37` |
| 4 | 调用预设 = 模型+推理可信组合；同模型多预设 | 已实现 | `config.ts:21-26, 131-135` |
| 5 | 方案只能引用 CLI 配置 + 预设 | 已实现 | `planning.ts:57-69`、`planning.test.ts:49-58` |
| 6 | 两层验证 + 共享组合不重复预检 | 已实现 | `config.ts` 静态层、`planning.ts:186-202` 去重 Map、`planning.test.ts:60-81` |
| 7 | `mad init` 探测 / 骨架 / 不覆盖 | 已实现 | `cli/index.ts:54-88`、`config.ts:200-221`、`init-template.test.ts` |
| 8 | 失败阻止启动、不替换 | 已实现 | `planning.ts:205-208`、`cli/index.ts:111-119` |
| 9 | `mad config validate` / `mad config check` | 已实现 | `cli/index.ts:106-126, 765-768` |
| 10 | 七个适配器 ID 全覆盖 | 已实现 | `config.ts:5`、`adapters/index.ts:7-21`、`generic.ts:18-29` |

### 4.1 已识别的微小差异（低严重度，不影响目标符合性）

- **`config/clis.toml` vs `MAD_HOME/config/clis.toml`**  
  - 目标架构第 4 节说「`config/clis.toml`」，实际路径是 `MAD_HOME/config/clis.toml`（`src/core/paths.ts:32`）。`MAD_HOME` 是应用数据根目录，这是隐式约定，符合目标「长期配置文件位于应用数据根目录」。  
  - 严重度：低（语义一致，非问题）。
- **审计：`tests-ts/adapters-ts.test.ts` 用 `codex` 之外的 fake-cli 不在审查范围**，仅 Codex 的 fake fixture 出现在 `tests-ts/cli-e2e.test.ts:12`，与本节无直接冲突。
- **占位符校验**：`config.ts:108-110` 显式拒绝 `model == "REPLACE_WITH_MODEL_ID"`，但对 `cli == "REPLACE_WITH_CLI_ID"` 与 `preset == "REPLACE_WITH_PRESET_ID"` 的占位符未单独拒绝；后者会先被 `idAt` 校验（`ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/`，`REPLACE_WITH_CLI_ID` 含大写与下划线 `REPLACE_` 会失败），但 `parseCliRegistry` 的 `defaults.generator.cli/preset` 字段并未走 `idAt` 的同一路径——实际上 `src/adapters/config.ts:162-163` 调用了 `idAt(generator.cli, ...)` 与 `idAt(generator.preset, ...)`，因此占位符同样会被拒绝。  
  - 严重度：低（最终结果一致；不必额外处理）。

### 4.2 未发现的问题

- 没有发现任何裸模型名、可执行路径、CLI 参数绕过注册表的入口。
- 没有发现任何 `extra_args` / 私有参数透传路径。
- 没有发现任何「预检失败自动降级」或「替换 CLI / 预设」逻辑。
- 没有发现任何在 `clis.toml` 中持久化 Agent / 角色 / 会话状态的设计。
- `defaults.generator.cli` / `preset` 引用的 schema 与解析与每个 preset ID 共享同一白名单与正则约束。
- 注册表解析与 `deliberate` 路径都依赖同一份 `parseCliRegistry`，没有第二份独立解析器造成行为漂移。

## 5. 结论

第 4 节与第 6 节中与「CLI 适配器与注册表」相关的 10 条约束全部已实现，且关键不变量由自动化测试守住：

- `clis.toml` 是唯一长期配置入口，无任何长期 Agent / 角色 / 会话状态；
- 适配器 schema 是闭包枚举 + 严格白名单，安全参数无配置入口；
- `extra_args` 等透传路径在配置层与调用层均被截断；
- 调用预设是「模型 + 推理等级 + 上下文预算」的最小可信单元，同模型允许多预设；
- 审议方案只引用 `cli + preset`，且运行时去重预检；
- `mad init` / `mad config validate` / `mad config check` 行为符合第 4 节；
- 失败一律抛错，无自动替换。

未发现影响目标架构符合性的阻塞问题，仅有路径形式（`config/clis.toml` vs `MAD_HOME/config/clis.toml`）等低严重度表述差异，已在 4.1 节记录。

---

---

**变更时间**：2026-07-21
**变更概要**：创建本审查报告；对 `docs/TypeScript目标架构.md` 第 4 节（CLI 注册表与模型调用预设）与第 6 节（CLI 与交互模式）中与 CLI 适配器、注册表、预设、方案约束、两层验证、`mad init`、失败行为、子命令和七个适配器相关的 10 条要求进行逐条对照，覆盖 `src/adapters/`、`src/cli/index.ts`、`src/core/planning.ts`、`src/core/paths.ts` 及 `tests-ts/config.test.ts`、`tests-ts/planning.test.ts`、`tests-ts/adapters-ts.test.ts`、`tests-ts/init-template.test.ts`，结论为全部已实现，未发现阻塞问题。

## 变更记录

- 2026-07-21：创建本审查报告（见上变更概要）。
- 2026-07-21：按 agent 目录重新整理，本文件归入 `docs/审查/codebuddy/`；修正相对链接。
