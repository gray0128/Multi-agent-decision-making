# 独立代码审查：CLI / 适配器 / 配置（对照 TypeScript 目标架构）

> 审查基准：`docs/TypeScript目标架构.md` 第 3、4、6、16 节，以及适配器/CLI 相关约束  
> 审查对象：`src/cli`、`src/adapters`、`src/core/{planning,types,limits,errors}.ts`、`package.json`、`tsconfig.json`、相关 `tests-ts`  
> 方法：只根据当前源码与测试证据判断；不引用其他审查报告，不采信「已通过」结论

---

## 1. 审查范围与方法

### 1.1 范围

| 架构条款 | 审查焦点 |
| --- | --- |
| §3 单包结构 | 单个 `package.json`；`src/{cli,core,adapters,archive,server,web}`；共享 schema/领域类型 |
| §4 CLI 注册表与调用预设 | `config/clis.toml` 形态；方案只引用 cli+preset；无 `extra_args`；两层验证；`init`/`validate`/`check` |
| §6 CLI 与交互模式 | structured/free；resume 不切换；guided/`--auto`/`--auto-confirm-plan`；无 TTY 且无观察服务立即失败 |
| §16 stdout/stderr/退出码 | 成功仅报告或完整 JSON；进度/警告进 stderr；失败无半截 JSON；分退出码 |
| 适配器 | codex + generic 等；类型化配置；禁止覆盖只读/审批/工具/输出格式/工作目录 |

### 1.2 方法

1. 阅读目标架构对应章节全文。  
2. 通读 `src/cli/index.ts`、`src/cli/output.ts`、`src/adapters/*`、`src/core/planning.ts` / `types.ts` / `limits.ts` / `errors.ts`。  
3. 用 CodeGraph / 定向检索核对调用链（组局预检、检查点、退出码、stdout）。  
4. 对照 `tests-ts` 中 config / adapters / init-template / planning / cli-e2e 等测试作为行为证据。  
5. 每条结论附带文件路径与行号。

### 1.3 不在本报告内展开（仅边界提及）

结构化/自由讨论阶段语义（§7–8）、观察服务认证细节（§11–12）、档案锁与恢复边界的完整语义（§13–14）——仅在与 CLI/适配器接口交叉处记录。

---

## 2. 符合项（附证据）

### 2.1 §3 单包代码结构

**结论：符合。**

- 仓库仅有一个 npm 包：`/Users/libo/Documents/github/Multi-agent-decision-making/package.json`（`name: multi-agent-decision`，`bin.mad` 指向 `./dist/cli/index.js`）。  
- 源码布局与架构一致：

```
src/
├── cli/          index.ts, output.ts
├── core/         planning, types, limits, errors, …
├── adapters/     config, codex, generic, process, …
├── archive/
├── server/
└── web/
```

- `tsconfig.json` 以 `src` 为 `rootDir`、`dist` 为 `outDir`，单项目编译，非 monorepo。  
- 领域类型集中于 `src/core/types.ts`；档案解析 `src/archive/schema.ts` 从 `core/types` 导入 `DELIBERATION_MODES` / `INTERACTION_POLICIES` 等；CLI 与适配器共用同一套 `CliRegistry` / `DeliberationPlan` / `InvocationPresetRef`。

### 2.2 §4 CLI 注册表与模型调用预设

**结论：整体符合。**

#### 2.2.1 `clis.toml` 形态：`defaults.generator` + `clis` + `presets`

配置路径为 `MAD_HOME/config/clis.toml`：

```29:35:src/core/paths.ts
export function appPaths(home = resolveAppHome()): AppPaths {
  return {
    home,
    config: join(home, "config", "clis.toml"),
    deliberations: join(home, "deliberations"),
    runtime: join(home, "runtime"),
  };
}
```

解析结构与架构示例一致（`defaults.generator.{cli,preset}`、`[[clis]]`、`[[clis.presets]]`、可选 `options`）：

```157:180:src/adapters/config.ts
export function parseCliRegistry(value: unknown): CliRegistry {
  const root = objectAt(value, "config");
  assertKeys(root, ["defaults", "clis"], "config");
  const defaults = objectAt(root.defaults, "defaults");
  assertKeys(defaults, ["generator"], "defaults");
  const generator = objectAt(defaults.generator, "defaults.generator");
  assertKeys(generator, ["cli", "preset"], "defaults.generator");
  // ...
  return { defaults: { generator: { cli: generatorCli, preset: generatorPreset } }, clis };
}
```

#### 2.2.2 方案只能引用 CLI + preset，禁止裸模型名 / 可执行路径 / 原始参数

`parseDeliberationPlan` 仅允许 `id/cli/preset/role`（自由讨论另加 `moderator_agent_id`），未知字段（含 `model`）直接拒绝，并通过 `resolveInvocation` 校验白名单：

```55:79:src/core/planning.ts
export function parseDeliberationPlan(payload: string | unknown, options: ParsePlanOptions): DeliberationPlan {
  // ...
  keysOnly(participant, ["id", "cli", "preset", "role"], path);
  // ...
  resolveInvocation(options.registry, cli, preset);
```

组局 prompt 明确禁止输出模型名、命令、路径与 CLI 参数（`src/core/planning.ts:227-235`）。  
测试：`tests-ts/planning.test.ts`「rejects fields that could escape the trusted registry」。

#### 2.2.3 不支持 `extra_args`

CLI 表字段白名单不含 `extra_args`；未知字段报错：

```130:133:src/adapters/config.ts
function parseCli(value: unknown, index: number): CliConfig {
  const path = `clis[${index}]`;
  const raw = objectAt(value, path);
  assertKeys(raw, ["id", "adapter", "executable", "timeout_seconds", "max_concurrency", "presets"], path);
```

测试：`tests-ts/config.test.ts`「rejects arbitrary pass-through arguments」期望 `/未知字段：extra_args/`。

#### 2.2.4 类型化预设 options（按适配器枚举）

```89:113:src/adapters/config.ts
  const allowedOptions = adapter === "codex" ? ["reasoning_effort"]
    : adapter === "claude" || adapter === "grok" ? ["effort"]
    : adapter === "pi" ? ["thinking"]
    : [];
  assertKeys(optionsRaw, allowedOptions, `${cliPath}.options`);
```

模板占位符 `REPLACE_WITH_MODEL_ID` 在加载时拒绝（`config.ts:114-117`）；测试覆盖于 `config.test.ts` / `init-template.test.ts`。

#### 2.2.5 两层验证；失败不自动替换

| 层 | 实现 | 证据 |
| --- | --- | --- |
| 加载静态 | `loadCliRegistry` → `parseCliRegistry` | `config.ts:183-198` |
| 运行时预检 | 组局器 `requireReady`；方案 `preflightPlan` 按唯一 `cli/preset` 去重 | `planning.ts:131-136`、`184-200` |
| 失败行为 | `MadError("PREFLIGHT", …)`，无降级/替换 | `planning.ts:203-207` |

共享组合不重复预检（参与者侧 Map 去重）：

```184:200:src/core/planning.ts
  public async preflightPlan(...): Promise<string[]> {
    const combinations = new Map<string, { adapter: CliAdapter; cliId: string; maximum: number }>();
    for (const participant of plan.participants) {
      const key = `${participant.invocation.cli}/${participant.invocation.preset}`;
      if (!combinations.has(key)) { /* ... */ }
    }
```

测试：`tests-ts/planning.test.ts`「preflights each unique invocation combination only once」。

#### 2.2.6 `mad init` 只探测；`config validate` / `config check`

- `initialize`：扫 PATH、对可执行文件做版本/探针调用，写入骨架；**不**填写真实 model / 默认组局器（占位符 `REPLACE_WITH_*`）。  
  证据：`src/cli/index.ts:55-89`，`buildConfigTemplate`：`config.ts:211-231`。  
- 已有配置默认 `flag: "wx"` 不覆盖，`--force` 才重建（`index.ts:77-84`）。  
- `mad config validate`：加载并解析注册表（`validateConfig(false)`，`index.ts:107-127`）。  
- `mad config check`：对全部 CLI×preset 组合 `adapter.check`（`index.ts:110-123`）。

### 2.3 §6 CLI 与交互模式

**结论：符合。**

| 要求 | 实现证据 |
| --- | --- |
| `structured` / `free` | `--mode` 校验，默认 `structured`（`index.ts:364-383`） |
| 两模式共享组局/预检/确认/workspace/输出 | 同一 `deliberate()` 管线，仅 controller 分支（`index.ts:521-539`） |
| `resume` 不切换模式/策略 | `resume` 仅解析 `--format`；`manifest.mode` / `manifest.interaction` 驱动执行（`index.ts:558-685`） |
| 默认 guided | `interaction = auto ? "auto" : "guided"`（`index.ts:386`） |
| `--auto` 跳过检查点 | auto 时不传 checkpoint handler（`index.ts:527`、`536`）；controller `if (!this.checkpoint) return`（`structured.ts:199`；`discussion.ts:223`） |
| `--auto-confirm-plan` 独立 | 可单独用于 guided 无 TTY；auto 仍强制要求该旗标（`index.ts:387-403`、`496-505`） |
| 仅自动接受首次有效方案 | auto-confirm 路径直接用 `proposed.plan`，不走交互修改（`index.ts:496-508`） |
| guided 无 TTY 且无观察服务立即失败 | `index.ts:396-400`（deliberate）、`584-588`（resume） |

机器调用示例路径（`--auto --auto-confirm-plan --format json`）由 `tests-ts/cli-e2e.test.ts` 覆盖。

无 TTY 时必须显式接受方案（观察服务不能做方案确认，仅检查点）：

```401:403:src/cli/index.ts
  if (interaction === "guided" && !terminalAvailable && !parsed.values["auto-confirm-plan"]) {
    throw new MadError("USAGE", "无交互终端时必须用 --auto-confirm-plan 接受首次有效组局方案");
  }
```

与架构「页面只能响应当前检查点」一致。

### 2.4 §16 stdout、stderr 与退出码

**结论：符合。**

#### 2.4.1 成功 stdout

```15:43:src/cli/output.ts
export function writeCompletedResult(options: { ... }): void {
  if (options.format === "markdown") {
    process.stdout.write(`${options.result.report}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    deliberation_id: options.deliberationId,
    status: "completed",
    mode: options.mode,
    report: options.result.report,
    participants: options.plan.participants,
    budget_usage: { ... },
    warnings: options.warnings,
    archive_path: options.archivePath,
  })}\n`);
}
```

字段覆盖架构要求的：审议 ID、状态、模式、报告、参与者、预算使用、警告、档案路径。

#### 2.4.2 进度 / 警告 / Token 地址 / 档案路径 → stderr

- 警告：`emitWarnings` → `process.stderr.write`（`output.ts:9-11`）  
- 进度：组局、方案、检查点提示均 `stderr`（`index.ts:473-507`、`278`、`326`）  
- `mad serve` URL：`stderr`（`index.ts:719`）  
- 档案路径：成功后 `stderr`（`index.ts:541`、`699`）

#### 2.4.3 失败不写半截 JSON

- 仅成功路径调用 `writeCompletedResult`。  
- 顶层 catch 只写 stderr 并设退出码：

```761:765:src/cli/index.ts
main().catch((error: unknown) => {
  const madError = error instanceof MadError ? error : new MadError("EXECUTION", ...);
  process.stderr.write(`错误：${madError.message}\n`);
  process.exitCode = EXIT_CODES[madError.code];
});
```

- e2e：失败时 `stdout` 为空（`cli-e2e.test.ts:46`、`100`、`214`）。

#### 2.4.4 分退出码

```27:35:src/core/errors.ts
export const EXIT_CODES: Readonly<Record<MadErrorCode, number>> = {
  USAGE: 2,
  CONFIG: 3,
  PREFLIGHT: 4,
  LOCKED: 5,
  PAUSED: 20,
  CANCELLED: 21,
  EXECUTION: 30,
};
```

覆盖架构列举的暂停、取消、配置、预检、执行失败等类别；e2e 验证 PAUSED=20、LOCKED=5、EXECUTION=30。

#### 2.4.5 非 TTY 无 ANSI（应用侧）

- CLI 自身不写 ANSI 着色。  
- Codex 固定 `--color never`（`codex.ts:63-64`）。  
- Generic 公开文本经 `cleanPublicText` 剥离 ANSI（`public-text.ts:1-43`）。

### 2.5 适配器：类型化边界与安全硬编码

**结论：符合架构「禁止配置覆盖只读/审批/工具/输出格式/工作目录」「不支持 extra_args」。**

#### 2.5.1 注册与工厂

```6:20:src/adapters/index.ts
export function createAdapter(cli: CliConfig, preset: InvocationPreset): CliAdapter {
  switch (cli.adapter) {
    case "codex": return new CodexAdapter(cli, preset);
    case "claude": case "reasonix": case "grok": case "pi": case "codebuddy": case "agy":
      return new GenericCliAdapter(cli, preset);
```

七个目标 CLI（codex / claude / reasonix / grok / pi / codebuddy / agy）均有适配器路径。

#### 2.5.2 Codex

- 硬编码：`exec --sandbox read-only --ephemeral --color never --skip-git-repo-check --model <preset>`（`codex.ts:58-72`）。  
- 可选仅 `reasoning_effort` 来自预设（非用户 extra_args）。  
- `cwd` 来自调用请求，非配置字段（`codex.ts:74`）。  
- 项目只读：`projectReadOnlyCapability = "runtime-canary"` + canary 验证（`codex.ts:9`、`52-54`）。

#### 2.5.3 Generic

`buildInvocationCommand` 按适配器固定安全边界（`generic.ts:20-30`），测试锁定关键参数：

| 适配器 | 硬编码要点（测试断言） |
| --- | --- |
| claude | `--permission-mode plan`、`--no-session-persistence`、受限 tools、`--safe-mode` |
| grok | `--permission-mode plan`、`--no-subagents`、`--no-memory`、`--cwd .` |
| pi | `--no-approve`、`--no-session`、只读 tools 列表 |
| codebuddy | `--permission-mode plan`、`--strict-mcp-config` |
| agy | `--mode plan`、`--sandbox` |
| reasonix | 有界 `max-steps`；`projectReadOnlyCapability = "unsupported"` |

配置层 **不存在** working_directory / sandbox / permission / tools / output_format / approval 可写字段（`config.ts` 白名单 + grep 无匹配）。

#### 2.5.4 子进程边界

- `shell: false`；participant 环境注入 `MAD_PARTICIPANT=1`（`process.ts:28-34`）。  
- CLI 入口拒绝参与者进程递归（`index.ts:734-736`）。  
- 超时、输出上限、中止信号均有处理（`process.ts`）。

### 2.6 相关测试覆盖（支持性证据）

| 测试文件 | 覆盖点 |
| --- | --- |
| `tests-ts/config.test.ts` | 预设解析、extra_args 拒绝、重复 preset、安全上限、占位 model、适配器 options 隔离 |
| `tests-ts/init-template.test.ts` | 不猜 generator/model、可写可执行路径 |
| `tests-ts/planning.test.ts` | 方案字段逃逸拒绝、唯一组合预检、项目只读阻断 |
| `tests-ts/adapters-ts.test.ts` | 各 CLI 只读边界钉死、ANSI/公开文本、脱敏 |
| `tests-ts/cli-e2e.test.ts` | structured/free JSON stdout、失败空 stdout、resume、锁、observer guided、暂停退出码 20 |

---

## 3. 偏差 / 缺口

### 3.1 Codex 最终输出未统一走 ANSI 清洗路径

| 项 | 内容 |
| --- | --- |
| **严重度** | 低 |
| **架构条款** | §16「非 TTY 输出不含 ANSI 控制字符」 |
| **证据** | `src/adapters/codex.ts:85-86` 使用 `result.stdout.trim()` 直接作为最终文本；对比 `src/adapters/generic.ts:92` 经 `publicText` → `cleanPublicText` 剥离 ANSI。Codex 虽传 `--color never`，但模型正文若含控制序列仍可能进入报告与 stdout。 |
| **影响** | 机器解析 JSON/Markdown 时偶发污染；与 generic 路径不一致。 |

### 3.2 guided + 观察服务：启动后 observer 离线时检查点可能长时间轮询

| 项 | 内容 |
| --- | --- |
| **严重度** | 低（残余风险；严格字面启动条件已满足） |
| **架构条款** | §6「既无交互终端也无在线观察服务时立即失败，不无限等待」 |
| **证据** | 启动时 `observerIsOnline` 检查：`src/cli/index.ts:396-400`。通过后 `CheckpointMailbox.wait` 在无 terminal handler 时 `while (true)` 每 200ms 读响应文件（`src/server/mailbox.ts:75-88`），**无** observer 存活续检或最长等待。 |
| **影响** | 无 TTY、仅依赖观察页的 guided 审议：若 serve 在检查点等待期间崩溃，进程可能挂起直至 SIGINT（转为暂停）或外部响应。不违反「启动时双无则失败」，但「不无限等待」的运营期望在中途失联场景不完整。 |

### 3.3 页面脚本未编译期共享 TypeScript 领域类型

| 项 | 内容 |
| --- | --- |
| **严重度** | 低 |
| **架构条款** | §3「CLI、服务端和页面共享同一套 schema 与领域类型」 |
| **证据** | 服务端/档案/CLI 共享 `core/types` + `archive/schema`。`src/web/index.ts` 中 `APP_JS` 为字符串内嵌脚本，以 ad-hoc 字段访问 API JSON，不 import 领域类型。 |
| **影响** | 契约一致性依赖 API 与人工对齐；schema 变更时页面无编译期校验。运行时权威仍在档案解析层。 |

### 3.4 `mad init` 探测强度略高于「仅路径」表述

| 项 | 内容 |
| --- | --- |
| **严重度** | 低 |
| **架构条款** | §4「只探测已安装 CLI 和可执行路径」 |
| **证据** | `src/cli/index.ts:64-74` 在 `findExecutable` 后还执行 `runProcess(executable, probe, …)`（`--version` / `version` / `help`），失败则不写入该 CLI。 |
| **影响** | 仍不猜测 model/思考等级/默认组局器，符合安全意图；仅比字面「路径探测」多一步可用性探针。一般可视为合理实现，记为轻微措辞偏差。 |

---

## 4. 风险与建议

1. **统一公开文本清洗**  
   Codex `invoke` 返回前复用 `cleanPublicText`（或与 generic 共用出口），保证 §16 在所有适配器一致。

2. **guided 无 TTY 时的 mailbox 超时/续检**  
   可选：`wait` 周期调用 `observerIsOnline`，连续失败 N 次则抛出明确错误（或提示仅剩 SIGINT 暂停），避免静默挂起。

3. **页面契约**  
   若要加强 §3「共享 schema」：用共享 DTO 生成 API 响应类型，或对关键 JSON 字段做轻量运行时校验；非必须，优先保证档案层 schema。

4. **保持现状的优点（勿回退）**  
   - 配置白名单 + 方案字段白名单双闸门是防 `extra_args`/裸模型逃逸的核心。  
   - `--auto` 与 `--auto-confirm-plan` 分旗标、失败分退出码、成功单点写 stdout 的契约清晰，e2e 已钉住。  
   - 适配器安全参数硬编码、预设 options 按适配器收窄，符合「配置不可覆盖安全边界」。

5. **无需视为缺陷的实现选择**  
   - 组局器预检 + 方案唯一组合预检可能对同一 `cli/preset` 各执行一次（`planning.test.ts` 期望 `check` 调用 2 次）：符合「先组局器、后方案组合」两阶段表述，不违反「多 Agent 共享组合不重复预检」。  
   - `executable` 可省略并回落到 adapter 名（`config.ts:150`）：模板与文档仍写全字段，属兼容默认值。

---

## 5. 小结评分

| 维度 | 评分 |
| --- | --- |
| §3 单包结构 | 符合 |
| §4 注册表 / 预设 / 两层验证 / init·validate·check | 符合（轻微措辞级偏差见 3.4） |
| §6 交互模式与 resume | 符合 |
| §16 stdout/stderr/退出码 | 符合（Codex ANSI 清洗见 3.1） |
| 适配器类型化与安全边界 | 符合 |
| **总评** | **基本符合** |

**汇总：**  
- 偏差/缺口条目：**4**（均为**低**严重度）  
- 最高严重度：**低**  
- 无高/中严重度架构违背；核心约束（单包、cli+preset 白名单、禁止 extra_args、两层验证、guided 双通道门禁、stdout 契约、分退出码、适配器安全硬编码）均有源码与测试证据支撑。

---

**变更记录**

- 2026-07-22：初稿。对照目标架构 §3/4/6/16 与适配器相关条款，基于 `src/cli`、`src/adapters`、`src/core` 关键子集与 `tests-ts` 完成独立审查；结论为基本符合，记录 4 条低严重度偏差/残余风险。
