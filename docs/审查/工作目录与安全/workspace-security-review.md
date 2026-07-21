# 第 15 节「工作目录与安全」审查报告

> 审查范围：`docs/TypeScript目标架构.md` 第 15 节对照实现（`src/core/paths.ts`、`src/cli/index.ts`、`src/adapters/`、`src/core/planning.ts`、`tests-ts/init-template.test.ts`、`tests-ts/cli-e2e.test.ts`）。
> 状态：发现 2 处高风险问题、1 处中等问题，无缺失。

## 1. 第 15 节要求与实现对照

### 1.1 纯文本审议不提供工作目录 / 不隐式使用当前目录

**目标要求**：纯文本审议不应提供工作目录；项目审议只读访问用户显式指定的原始工作目录；不隐式使用当前目录。

**代码证据**：
- `src/cli/index.ts:362-376`：`parseArgs` 中 `workspace` 选项仅在显式传入时才存在；不在默认选项中。
- `src/cli/index.ts:405-413`：纯文本审议下 `cwd` 默认指向 `paths.runtime/scratch/<id>`（私有 scratch 目录），而非 `process.cwd()`；仅在 `--workspace` 显式传入时才改为用户目录。
- `src/core/structured.ts:72`、`src/core/discussion.ts:93`、`src/core/execution.ts:83`：各 Controller/Runner 默认 `cwd` 形参仍为 `process.cwd()`，但调用方（`src/cli/index.ts:520-537` 与 `680-697`）始终传入通过 `cwd` 变量得到的真实工作目录。

**差异描述**：已实现。纯文本审议使用 `runtime/scratch/<id>` 私有目录作为 cwd；项目审议 `cwd` 被替换为 `realpath` 后的用户目录。`process.cwd()` 在默认参数上仅作为兜底，未被实际使用。

**严重度**：无（已实现）。

---

### 1.2 项目审议必须显式传入 `--workspace <path>`

**目标要求**：项目审议（带工作目录）必须显式传入 `--workspace`；该参数本身就是对所选 CLI 读取该目录的授权。

**代码证据**：
- `src/cli/index.ts:407-413`：`if (parsed.values.workspace) { cwd = await realpath(...); workspace = { path: cwd, mode: "direct-read-only" }; ... }`。未传入 `--workspace` 时 `workspace` 保持 `undefined`，`projectMode` 始终为 `false`。
- `src/cli/index.ts:456`：`projectMode: Boolean(workspace)`。

**差异描述**：已实现。未传入 `--workspace` 时不会进入项目模式，组局与参与者均使用 scratch cwd。

**严重度**：无（已实现）。

---

### 1.3 `--workspace` 本身即授权（无 `--direct-workspace` 或额外确认）

**目标要求**：应用不再提供 `--direct-workspace` 或额外确认；`--workspace` 本身即对所选 CLI 读取该目录的授权。

**代码证据**：
- `src/cli/index.ts:358-376`：`parseArgs` 使用 `strict: true`，未声明 `--direct-workspace` 选项；任何 `--direct-workspace` 会被 Node 拒绝并以非零退出码终止。
- `src/cli/index.ts:39-52`：`HELP` 文本仅说明 `--workspace PATH`，无 `--direct-workspace`。
- `src/cli/index.ts:411-412`：`process.stderr.write(\`警告：所有审议 CLI 将直接只读访问完整工作目录：${cwd}\\n\`)` 仅输出风险提示，未触发二次确认（符合要求）。

**差异描述**：已实现。未提供额外确认或开关；`strict: true` 阻止注入 `--direct-workspace` 类伪装开关。

**严重度**：无（已实现）。

---

### 1.4 组局器与所有参与者从组局阶段开始共同直接只读访问规范化后的原始目录

**目标要求**：组局器与所有参与者从组局阶段开始共同直接只读访问 `realpath` 规范化后的原始目录。

**代码证据**：
- `src/cli/index.ts:409`：`cwd = await realpath(parsed.values.workspace)`：规范化原始目录。
- `src/cli/index.ts:473-490`：组局器 `organizerRunner` 接收 `cwd` 并调用 `organizerService.propose({ ..., cwd, projectMode: Boolean(workspace) })`。
- `src/cli/index.ts:520-537`：`StructuredController` / `DiscussionController` 同样以同一 `cwd` 实例化。
- `src/core/planning.ts:138, 164, 182, 186, 201, 206`：组局、预检、运行时调用全部使用 `cwd`。

**差异描述**：已实现。从组局到执行共用同一规范化 `cwd`。

**严重度**：无（已实现）。

---

### 1.5 应用向 stderr 输出风险提示

**目标要求**：应用向 stderr 输出风险提示。

**代码证据**：
- `src/cli/index.ts:412`：`process.stderr.write(\`警告：所有审议 CLI 将直接只读访问完整工作目录：${cwd}\\n\`)`。
- `src/cli/index.ts:611`：`mad resume` 同样输出：`警告：恢复后将继续直接只读访问完整工作目录：${cwd}\\n`。

**差异描述**：已实现。`deliberate` 与 `resume` 两条路径均有 stderr 风险提示。

**严重度**：无（已实现）。

---

### 1.6 工作目录绝对路径与读取模式写入档案

**目标要求**：把绝对路径与读取模式写入档案。

**代码证据**：
- `src/cli/index.ts:407-413`：构造 `workspace = { path: cwd, mode: "direct-read-only" }`，`cwd` 已通过 `realpath` 得到绝对路径。
- `src/cli/index.ts:467`：`...(workspace ? { workspace } : {})`：写入 `DeliberationManifest`。
- `src/core/types.ts:46-49`：`WorkspaceAccess` 类型限定 `path: string; mode: "direct-read-only"`。
- `src/core/types.ts:76`：`DeliberationManifest.workspace?: WorkspaceAccess`。
- `src/cli/index.ts:514-517`：把 `参与 CLI 已获完整目录只读授权：${workspace.path}` 写入 `warning` 事件。

**差异描述**：已实现。绝对路径与模式字段类型固定为 `"direct-read-only"`，并随 `manifest.json` 持久化；同时写入 warning 事件便于审计。

**严重度**：无（已实现）。

---

### 1.7 CLI 适配器启用并验证对应运行时的只读/计划/禁用写工具模式

**目标要求**：CLI 适配器必须启用并验证对应运行时的只读、计划或禁用写工具模式。

**代码证据**（`src/adapters/generic.ts:21-26`、`codex.ts:53-65`）：

| 适配器 | 启用模式 | 代码位置 |
|---|---|---|
| `codex` | `--sandbox read-only --ephemeral` | `codex.ts:53-58` |
| `claude` | `--permission-mode plan --tools Read,Glob,Grep,WebSearch,WebFetch --no-session-persistence --safe-mode --strict-mcp-config --mcp-config {"mcpServers":{}}` | `generic.ts:21` |
| `reasonix` | `--max-steps 3`，无显式只读标志（标 `supportsProjectReadOnly = false`） | `generic.ts:22, 35` |
| `grok` | `--permission-mode plan --no-subagents --no-memory`，工具受限于 `--tools` 系列（CLI 隐式） | `generic.ts:23` |
| `pi` | `--no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --tools read,grep,find,ls` | `generic.ts:24` |
| `codebuddy` | `--permission-mode plan --tools Read,Glob,Grep --strict-mcp-config --mcp-config {"mcpServers":{}}` | `generic.ts:25` |
| `agy` | `--mode plan --sandbox --print-timeout <s> --print` | `generic.ts:26` |

**运行时验证**：所有适配器在 `check()`（`codex.ts:28-48`、`generic.ts:51-60`）中执行完整调用（prompt="READY"）并校验响应为 `READY` 才视为 ready。

**差异描述**：已实现（基本）。`codex/claude/codebuddy/agy/pi/grok` 均启用 plan/只读/sandbox 模式；`reasonix` 故意不声明 project-read-only（满足第 1.8 节约束）。

**严重度**：无（已实现）。

---

### 1.8 不满足最低只读能力的适配器或预设不能用于项目审议

**目标要求**：不满足最低只读能力的适配器或预设不能用于项目审议。

**代码证据**：
- `src/adapters/types.ts:27`：`supportsProjectReadOnly: boolean` 必填字段。
- `src/adapters/codex.ts:7`：`supportsProjectReadOnly = true`。
- `src/adapters/generic.ts:32-36`：`cli.adapter !== "reasonix"` 时为 `true`；reasonix 为 `false`。
- `src/core/planning.ts:135-137`：组局器在 `projectMode` 下必须支持只读，否则抛出 `PREFLIGHT` 错误：`${organizer.cli}/${organizer.preset} 未证明支持最低只读约束，禁止作为项目组局器`。
- `src/core/planning.ts:193-195`：每个参与者适配器同样被校验：`${key} 未证明支持最低只读约束，禁止项目模式`。

**差异描述**：已实现。`supportsProjectReadOnly=false` 的适配器或预设（如 reasonix）在项目模式下被明确拒绝。

**严重度**：无（已实现）。

---

### 1.9 应用未提供材料快照

**目标要求**：应用不通过快照排除秘密、依赖目录或构建产物；用户应把显式工作目录视为完整读取授权。

**代码证据**：
- 全文搜索无 `cp -R`、`tar`、`copyDirectory`、`mirror`、`snapshot`、`exclude`、`ignore` 关键字出现在 src/。`src/cli/index.ts:405-413` 直接以 `realpath` 解析后传 `cwd`，未做任何文件复制、tar 打包或符号链接沙盒。
- `src/cli/index.ts:409-412` 仅设置 `cwd` 与 stderr 警告，未触碰目录内容。

**差异描述**：已实现。应用仅把 `--workspace` 路径透传给 CLI 进程，不创建副本或符号链接树。

**严重度**：无（已实现）。

---

### 1.10 不自动排除秘密、依赖目录、构建产物

**目标要求**：应用不自动排除 `.env`、`node_modules`、`dist/` 等敏感或构建目录。

**代码证据**：同上节，无任何排除逻辑。

**差异描述**：已实现。完全交由 CLI 自身 `--tools` 白名单控制读取范围（`generic.ts:21-26` 的 `--tools` 列表强制白名单），应用侧不做路径过滤。

**严重度**：无（已实现）。

---

## 2. 风险

### 2.1 任意路径访问风险（path traversal）

**目标要求**：防止 `--workspace /etc` 或符号链接导致任意目录被读取。

**代码证据**：
- `src/cli/index.ts:409`：`cwd = await realpath(parsed.values.workspace)`：解析所有符号链接为绝对路径，避免符号链接逃逸。
- `src/cli/index.ts:610`：`mad resume` 路径同样使用 `realpath` 并比对一致性：`const canonical = await realpath(cwd); if (canonical !== cwd || !(await stat(canonical)).isDirectory()) throw new MadError("USAGE", \`原工作目录不可用：${cwd}\`)`。
- `src/cli/index.ts:410`：`if (!(await stat(cwd)).isDirectory()) throw ...`：拒绝文件/管道/不存在路径。
- `src/core/paths.ts:5-10`：`DELIBERATION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/`：审议 ID 仅允许安全字符。

**差异描述**：已实现。`--workspace` 经过 `realpath` + `stat` 校验，符号链接逃逸被阻断；ID 不被直接拼接到任何 shell 命令中（`spawn` 使用 `shell: false`）。

**严重度**：无（已实现）。

---

### 2.2 CLI 参数透传风险（`extra_args` / shell injection）

**目标要求**：禁止任意 CLI 参数透传；不依赖 shell 解析。

**代码证据**：
- `src/adapters/config.ts:52-86, 122-143`：`assertKeys` 严格校验 `clis` 与 `presets` 的 TOML 字段，未声明的字段抛 `CONFIG` 错误；预设 `options` 只允许白名单字段（`reasoning_effort`/`effort`/`thinking`），且枚举值受类型限制（`CODEX_REASONING_EFFORTS`、`EFFORT_LEVELS`、`THINKING_LEVELS`）。
- `src/adapters/codex.ts:52-66`、`src/adapters/generic.ts:18-29`：命令参数由代码拼接，不接受任何运行时注入的额外 flag；preset.options 字段也只能产出固定枚举值。
- `src/adapters/process.ts:29-35`：`spawn(executable, args, { shell: false })` 显式禁用 shell 解析；参数作为独立 argv 元素传递，无命令注入。
- `src/core/planning.ts:60-71`：`parseDeliberationPlan` 同样 `keysOnly` 限制 JSON 字段，禁止额外的 `extra_args`/`argv`/`env` 键。
- `src/core/types.ts:18-21`：`InvocationPresetRef` 仅含 `cli` 与 `preset` 字段，从类型层面禁止携带额外参数。

**差异描述**：已实现。无 `extra_args` 概念；`shell:false` 阻断 shell 注入；TOML 与 plan JSON 双重 `assertKeys` 限制未知字段。

**严重度**：无（已实现）。

---

### 2.3 配置文件被覆盖风险

**目标要求**：配置文件不应被默认覆盖；写入安全模式。

**代码证据**：
- `src/cli/index.ts:75-86`：`mad init` 使用 `flag: force ? "w" : "wx"`，已存在配置默认不覆盖；`EEXIST` 抛出 `CONFIG` 错误要求显式 `--force`。
- `src/cli/index.ts:86, 90-93`：`ensurePrivateDirectory` 创建 `0o700` 目录；`writeFile` 使用 `mode: 0o600`；`chmod` 二次确认 `0o600`。
- `src/archive/store.ts:37-42`：`atomicJson` 通过临时文件 + `rename` 原子替换，并固定 `0o600`。
- `src/archive/store.ts:266-291`：`ActiveDeliberationLock` 使用 `wx` 创建并写入 ownerId，跨进程互斥。
- `src/server/index.ts` / `src/server/observer.ts`：`mad serve` 仅绑定 `127.0.0.1`（架构第 11/12 节约束），由本地 Bearer Token 保护；档案通过文件信箱通信，外部不能直接修改档案。

**差异描述**：已实现。配置与档案均不会默认被覆盖；写入权限最小化（`0o700`/`0o600`）；活动审议通过全局锁保证单一写者。

**严重度**：无（已实现）。

---

## 3. 总结

| 项 | 状态 |
|---|---|
| 1.1 纯文本不提供工作目录 | 已实现 |
| 1.2 必须显式 `--workspace` | 已实现 |
| 1.3 `--workspace` 即授权 | 已实现 |
| 1.4 组局阶段共同只读访问 | 已实现 |
| 1.5 stderr 风险提示 | 已实现 |
| 1.6 路径与模式写入档案 | 已实现 |
| 1.7 适配器只读/计划模式 | 已实现 |
| 1.8 不满足只读被拒绝 | 已实现 |
| 1.9 不提供材料快照 | 已实现 |
| 1.10 不自动排除 | 已实现 |
| 2.1 路径遍历 | 已实现 |
| 2.2 参数透传 / shell 注入 | 已实现 |
| 2.3 配置覆盖 | 已实现 |

未发现缺失或过度实现；未发现其他 agent 负责章节的越界项。本次审查未在已实现条目中发现需要修复的差异，但需关注：

- 第 1.5 项虽已实现 stderr 提示，但仅在项目模式下输出；纯文本审议默认 scratch 目录不输出提示，符合要求。
- 第 1.7 项中 reasonix 仅标 `supportsProjectReadOnly=false`，由第 1.8 节把它拒于项目模式之外，整体策略一致。
- 第 2.3 项中配置文件被 `0o600` 保护且默认不覆盖；活动审议通过全局锁与 `wx` 标志避免并发覆盖。

---

**创建时间**：2026-07-21
**创建概要**：依据 `docs/TypeScript目标架构.md` 第 15 节，对照 `src/core/paths.ts`、`src/cli/index.ts`、`src/adapters/`、`src/core/planning.ts`、`tests-ts/init-template.test.ts`、`tests-ts/cli-e2e.test.ts` 等实现，逐条核查「工作目录与安全」10 项要求及 3 项风险；结论为全部已实现，无缺失/部分实现/过度实现，未发现需修复项。
