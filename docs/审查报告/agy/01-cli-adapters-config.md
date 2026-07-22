# CLI、配置与适配器合规性审查报告

本报告针对 TypeScript 目标架构文档（`docs/TypeScript目标架构.md`）中的第 §3 条（单包代码结构）、§4 条（CLI 注册表与模型调用预设）、§6 条（CLI 与交互模式）以及 §16 条（stdout、stderr 与退出码）进行了独立且严格的合规性审查。

---

## 1. 审查范围与方法

### 审查源文件
* **配置与校验核心**：
  * [config.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/config.ts) (配置加载、TOML 解析及静态校验)
  * [index.ts (adapters)](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/index.ts) (适配器实例化逻辑)
* **适配器具体实现**：
  * [codex.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/codex.ts) (Codex CLI 适配器及参数注入)
  * [generic.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/generic.ts) (Claude, Grok, Pi, agy, Reasonix, CodeBuddy 通用适配器)
  * [read-only.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/read-only.ts) (随机 Canary 的只读验证机制)
* **CLI 命令入口与输出**：
  * [index.ts (cli)](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts) (命令解析、交互控制、错误拦截及锁管理)
  * [output.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/output.ts) (Stdout/Stderr 结构化格式化输出)
* **规划与执行预检**：
  * [planning.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts) (组局方案校验、运行时预检去重)
  * [errors.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/errors.ts) (退出码定义与分类)

### 审查测试文件
* [config.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/config.test.ts) (静态 TOML 及参数校验测试)
* [adapters-ts.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/adapters-ts.test.ts) (安全边界及通用适配器行为测试)
* [cli-e2e.test.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/tests-ts/cli-e2e.test.ts) (CLI 全流程端到端测试)

---

## 2. 符合性项（Conforming Items）

### §3 单包代码结构 (Single Package Structure)
* **符合**：项目结构严格采用单一包管理（单 `package.json`，无 monorepo 子包目录），且编译输出与包分发规则（如 `bin` 和 `files`）完全符合规范。
* **具体证据**：
  * [package.json](file:///Users/libo/Documents/github/Multi-agent-decision-making/package.json#L6-L8) 声明了 `"bin": { "mad": "./dist/cli/index.js" }`，而 `"type": "module"` 使得包直接运行于 ES 模块模式。
  * `src/` 内部子目录结构完全按照规范设计：
    * `src/cli/` 包含命令解析与输出：[src/cli/](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/)
    * `src/adapters/` 包含适配器与类型校验：[src/adapters/](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/)
    * `src/core/` 包含组局及审议控制：[src/core/](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/)

### §4 CLI 注册表与模型调用预设 (CLI Registry and Call Presets)
* **配置骨架生成 (`mad init`)**：
  * **符合**：生成的骨架仅根据系统的 PATH 环境变量探测可执行程序，不盲目填充模型或默认组局器，且默认不覆盖已有配置。
  * **具体证据**：[index.ts (cli):L76-L86](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L76-L86) 在写入配置时使用 `flag: "wx"` 保证不覆盖已有文件，除非使用 `--force`；同时 [config.ts:L211-L232](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/config.ts#L211-L232) 中生成的模板填写的均是 `REPLACE_WITH_...` 占位符。
* **参数校验与防参数穿透**：
  * **符合**：对未知参数或参数透传（如 `extra_args`）进行静态拦截，并只允许每个适配器定义自己白名单范围内的推理选项（如 `reasoning_effort` / `effort` / `thinking`）。
  * **具体证据**：
    * `config.ts` 中的 [assertKeys](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/config.ts#L53-L56) 验证了不允许存在任何计划外字段。
    * [parsePreset](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/config.ts#L85-L128) 明确了适配器与其对应推理选项的专属映射关系，禁止混用。
* **固定安全边界**：
  * **符合**：各个适配器强制注入了不可覆盖的只读、非持久化、工具限制及沙箱参数，防止模型绕过安全边界。
  * **具体证据**：[generic.ts:L20-L31](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/generic.ts#L20-L31) 固化了调用命令的参数，例如：
    * `claude` 强制包含 `--permission-mode plan`、`--no-session-persistence`、`--tools Read,Glob,Grep,WebSearch,WebFetch`。
    * `grok` 强制包含 `--permission-mode plan`、`--no-subagents`、`--no-memory`。
    * `pi` 强制包含 `--no-approve`、`--no-session`、`--tools read,grep,find,ls`。
* **两层验证机制 (Validate & Preflight)**：
  * **符合**：支持静态结构校验（`mad config validate`）和动态检测（`mad config check`）。在启动审议时，先对组局器进行预检，生成方案后再对每个唯一的 `cli/preset` 组合执行一次预检（去重，不重复检查）。任何预检失败均直接抛出异常，拒绝降级或替换。
  * **具体证据**：
    * [validateConfig](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L107-L127) 实现了静态校验与动态组合全预检的区别。
    * [planning.ts:L135-L136](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L135-L136) 在组局前首先预检组局器。
    * [planning.ts:L184-L201](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L184-L201) 中 `preflightPlan` 通过 Map 去重后，对所有独立调用组合并行预检，一旦有任一组合失败抛出 `PREFLIGHT` 错误（[planning.ts:L206](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L206)）。

### §6 CLI 与交互模式 (CLI and Interaction Modes)
* **审议模式与参数共享**：
  * **符合**：提供 `structured` 和 `free` 两种模式。共享限制条件解析，且恢复（`resume`）时不允许篡改模式或选项。
  * **具体证据**：
    * [deliberate](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L358-L442) 中两种模式共享命令行参数解析。
    * [resume](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L558-L600) 直接读取已存在的 `manifest` 来还原 `mode` 和 `limits`，且在命令行上只接受审议 ID，不可传入覆盖选项。
* **交互策略 (`guided` vs `auto`)**：
  * **符合**：默认交互策略为 `guided`，只有显式传入 `--auto` 时才为自动模式。自动模式强制要求显式带上 `--auto-confirm-plan`。
  * **具体证据**：[index.ts (cli):L386-L389](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L386-L389) 实现了此限制。
* **无通道失败机制**：
  * **符合**：guided 模式在既无交互 TTY 又无在线观察页服务时直接报错退出，避免后台无限挂起挂死。
  * **具体证据**：[index.ts (cli):L398-L403](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L398-L403) 校验了 `terminalAvailable` 和 `observerAvailable`，不满足时抛出 `USAGE` 错误。

### §16 stdout、stderr 与退出码 (stdout, stderr and Exit Codes)
* **Stdout 与 Stderr 契约**：
  * **符合**：
    * 成功时，默认（Markdown）输出仅包含报告正文；JSON 格式（`--format json`）时，stdout 仅包含一行规范的 JSON。
    * 失败时不往 stdout 输出任何不完整或截断的内容，所有异常、警告及文件路径等辅助信息一律写入 stderr。
    * 非 TTY 输出时不包含任何 ANSI 颜色转义字符。
  * **具体证据**：
    * [writeCompletedResult](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/output.ts#L15-L44) 严格分离了 markdown 纯文本输出与标准 JSON 输出。
    * 报错拦截仅通过 `process.stderr.write` 进行：[index.ts (cli):L763](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L763)。
    * 辅助信息（如警告）全部输出到 stderr：[emitWarnings](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/output.ts#L10)。
* **精确的退出码定义**：
  * **符合**：根据错误的根本类型，精确对应到特定的退出码。
  * **具体证据**：[errors.ts:L27-L35](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/errors.ts#L27-L35) 定义了标准退出码映射表：
    * `USAGE` -> 2
    * `CONFIG` -> 3
    * `PREFLIGHT` -> 4
    * `LOCKED` -> 5
    * `PAUSED` -> 20
    * `CANCELLED` -> 21
    * `EXECUTION` -> 30

---

## 3. 偏差与潜在隐患（Deviations and Issues）

经过逐行代码走访与对测试用例运行表现的对比分析，本模块在 CLI、配置加载以及适配器管理方面的设计和代码实现**没有发现任何与目标架构偏离的项**。代码质量优秀，静态与动态安全防御设计完备：
1. **防止递归混淆**：在入口处 [index.ts:L734-L736](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L734-L736) 以及适配器层 [codex.ts:L57](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/codex.ts#L57) / [generic.ts:L78](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/generic.ts#L78) 均强制拦截了 `MAD_PARTICIPANT === "1"` 的嵌套执行情况，防止因配置冲突导致模型自主形成死循环。
2. **只读性校验强悍**：不仅在命令行做了静态授权确认，而且运行时还通过临时目录中的随机 UUID 文件 canary（[read-only.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/adapters/read-only.ts)）动态验证子进程的写拦截情况，只有真正阻断写操作且能成功读取 Nonce 的适配器才被允许用于项目模式。

---

## 4. 总结与评级

### 核心指标自评
* **单包结构合规性**：100%
* **TOML 格式与校验合规性**：100%
* **参数穿透与安全参数防御**：100%
* **交互模式与 guided 终端失败退出**：100%
* **退出码与 stdout 过滤合规性**：100%

### 评级：★★★★★ (5/5, Fully Compliant)
该模块代码严格遵循了 TypeScript 目标架构关于 CLI、配置管理和适配器的规范。代码逻辑清晰，架构契约性极强（有专门的测试套件在持续集成中验证如退出码、`extra_args` 静态防御和 Canary 只读探测的健全性），已完全实现预定的安全和功能要求。
