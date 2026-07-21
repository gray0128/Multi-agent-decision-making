# Multi Agent Decision

> 当前仓库仍运行 Python MVP。已确认但尚待实现的 TypeScript CLI、自由讨论和审议观察页架构见 [TypeScript 目标架构](docs/TypeScript目标架构.md)；迁移完成前，以下安装与使用说明仍以当前 Python 实现为准。

通过 Microsoft Agent Framework 编排本机已安装并完成认证的 AI CLI，围绕一个问题开展结构化、多 Agent、只读审议，并生成可恢复、可审计的共同报告。

本项目目前只正式支持 macOS。DevUI 是仅供本机使用的开发工具，不是生产服务，也不支持远程或公网暴露。

详细设计见 [MVP 设计](docs/MVP设计.md)，领域术语见 [CONTEXT.md](CONTEXT.md)，关键决策见 [ADR](docs/adr)。

## 1. 安装

前置条件：

- Python 3.12；
- [uv](https://docs.astral.sh/uv/)；
- 至少两个已安装、已认证且支持非交互调用的 CLI；
- 可选 CLI：Codex、Claude Code、Reasonix、Grok、Pi、CodeBuddy、Antigravity CLI（`agy`）。

从仓库安装为独立工具：

```bash
git clone <仓库地址>
cd Multi-agent-decision-making
uv tool install .
mad --help
```

已在隔离的空 tool 目录验证：`uv tool install .` 会安装一个名为 `mad` 的可执行文件，随后 `mad init` 和 `mad agents` 可直接运行。如果终端找不到 `mad`，执行 `uv tool update-shell`，再重开终端。

升级本地源码安装：

```bash
git pull --ff-only
uv tool install --force --reinstall-package multi-agent-decision .
```

`--force` 只强制安装工具，不能保证重新构建版本号未变化的本地包。更新后的源码仍使用相同版本号时，必须同时使用
`--reinstall-package multi-agent-decision`，否则 uv 可能复用旧构建缓存。

卸载：

```bash
uv tool uninstall multi-agent-decision
```

参与开发时使用仓库虚拟环境：

```bash
uv sync --dev
uv run mad --help
uv run pytest -q
```

## 2. 初始化与 Agent 注册表

首次运行：

```bash
mad init
mad agents
```

`mad init` 创建数据目录并按本机可执行文件探测结果生成 `config/agents.toml`。已有配置不会被覆盖。`mad init --force` 会覆盖现有注册表，使用前请自行备份。

默认数据目录：

```text
~/Library/Application Support/MultiAgentDecision/
```

测试或隔离运行可以覆盖根目录：

```bash
MAD_HOME="$PWD/.mad-local" mad init
```

不要把 API Key、Token、密码或登录状态写入 `agents.toml`。认证继续由各 CLI 自己管理。安全的多模型示例：

```toml
[[agents]]
id = "pi-deepseek"
name = "Pi · DeepSeek V4 Pro"
adapter = "pi"
model = "deepseek/deepseek-v4-pro"
role = "侧重严谨推理、识别假设和构造反例"
enabled = true
default_report = false
timeout_seconds = 300
context_budget = 1000000
extra_args = []

[[agents]]
id = "pi-minimax"
name = "Pi · MiniMax-M3"
adapter = "pi"
model = "minimax/MiniMax-M3"
role = "侧重发现遗漏、矛盾和不可执行的建议"
enabled = true
default_report = true
timeout_seconds = 300
context_budget = 1000000
extra_args = []

[[agents]]
id = "codebuddy-reviewer"
name = "CodeBuddy Reviewer"
adapter = "codebuddy"
role = "只审阅风险、证据和可执行性"
enabled = true
default_report = false
timeout_seconds = 300
context_budget = 64000
extra_args = []

[[agents]]
id = "agy-gemini-flash"
name = "Antigravity · Gemini 3.5 Flash Low"
adapter = "agy"
model = "Gemini 3.5 Flash (Low)"
role = "侧重快速核验实现证据和交付风险"
enabled = true
default_report = false
timeout_seconds = 300
context_budget = 1000000
extra_args = []
```

字段说明：

| 字段 | 含义 |
|---|---|
| `id` | 唯一且稳定的 Agent ID；写入记录、恢复状态和 JSON 输出 |
| `name` | 展示名称 |
| `adapter` | `codex`、`claude`、`reasonix`、`grok`、`pi`、`codebuddy` 或 `agy` |
| `model` | 可选模型 ID；Pi 推荐使用精确的 `provider/model` |
| `role` | 默认角色说明；单次审议可用 `--role` 覆盖 |
| `executable` | 可选可执行文件名或路径；省略时按 `adapter` 从 `PATH` 查找 |
| `extra_args` | 可选参数数组；不会经过 shell 解析，不得包含秘密 |
| `enabled` | 是否允许进入预检和审议方案 |
| `default_report` | 默认报告 Agent；启用项中最多一个 |
| `timeout_seconds` | 单次 CLI 调用超时 |
| `context_budget` | 声明的上下文 token 预算 |

同一适配器可以注册多个 Agent，但 `id` 必须不同。模型、显示名称、适配器和 Agent ID 会分别写入正式发言元数据与最终方案。

## 3. 快速开始

### 3.1 纯文本审议

```bash
mad deliberate "比较方案 A 与方案 B" \
  --agents codex,claude \
  --report-agent codex
```

程序会先显示最终审议方案。直接回车确认，或输入 JSON 修改参与者、临时角色和报告 Agent。

### 3.2 项目审议：默认材料快照

```bash
mad deliberate "检查当前架构的并发风险" \
  --workspace . \
  --agents codex,claude
```

提供 `--workspace` 后默认制作材料快照。快照排除版本库元数据、环境文件、密钥、依赖和构建产物等敏感模式；参与者不会修改原目录。

### 3.3 直接只读访问原工作目录

```bash
mad deliberate "检查未提交改动" \
  --workspace . \
  --direct-workspace \
  --agents codex,claude
```

`--direct-workspace` 必须与 `--workspace` 一起使用。它跳过材料快照，隔离强度低于默认模式，只应在明确需要读取未跟踪或实时变化内容时启用。

### 3.4 引导模式与检查点

```bash
mad deliberate "评估迁移步骤" \
  --agents codex,claude \
  --interactive
```

引导模式在独立陈述、质疑与补充、争议判定和报告草稿后暂停。用户可以继续、添加指导、覆盖争议触发或取消。取消与异常会保留可恢复状态和材料快照。

### 3.5 组局 Agent 与临时角色

组局默认关闭。显式传入 `--organizer` 才会让该 Agent 从已启用且预检成功的安全注册表视图提出方案：

```bash
mad deliberate "评估迁移路径" \
  --organizer codex \
  --agents codex,claude \
  --report-agent claude \
  --role codex=架构主张者 \
  --role claude=风险审阅者
```

`--agents`、`--report-agent` 和可重复的 `--role AGENT_ID=ROLE` 可以覆盖组局建议。所有方案都必须最终确认；组局输出不能创建命令、模型、参数、秘密或修改 `agents.toml`。

### 3.6 JSON 与自动化调用

Coding Agent 或脚本应显式确认已经核对过的方案，并把标准输出作为唯一机器结果：

```bash
mad deliberate "比较两个重构方案" \
  --workspace . \
  --agents pi-deepseek,pi-minimax \
  --report-agent pi-minimax \
  --convergence auto \
  --confirm-plan \
  --format json \
  > result.json
```

进度、预检信息、方案展示和警告写入 stderr；最终 Markdown 或单个 JSON 对象写入 stdout。JSON 包含审议 ID、状态、报告、警告、实际参与者、完整最终方案、收敛信息和档案路径。

### 3.7 恢复未完成审议

```bash
mad resume <审议ID>
mad resume <审议ID> --interactive --format json --concurrency 4
```

等待交互检查点的审议必须带 `--interactive` 恢复。已完成阶段不会重复调用；未完成阶段由全部参与者整体重跑，部分输出只保留在诊断中。

## 4. 全部 CLI 命令与参数

随时运行 `mad <命令> --help` 查看当前帮助。

### `mad init`

```text
mad init [--force]
```

- `--force`：覆盖现有 `agents.toml`；请先备份。

### `mad agents`

列出注册表中的 Agent ID、显示名称、适配器和启用状态：

```bash
mad agents
```

### `mad deliberate`

```text
mad deliberate QUESTION [OPTIONS]
```

| 参数 | 中文说明 | 示例 |
|---|---|---|
| `QUESTION` | 要审议的问题 | `"是否迁移数据库"` |
| `-w, --workspace PATH` | 工作目录；默认制作快照 | `--workspace .` |
| `--direct-workspace` | 直接只读访问原目录 | `--workspace . --direct-workspace` |
| `--agents IDS` | 逗号分隔的参与者 ID | `--agents codex,claude` |
| `--report-agent ID` | 报告 Agent ID | `--report-agent codex` |
| `--organizer ID` | 按次启用组局 Agent；默认关闭 | `--organizer codex` |
| `--role ID=ROLE` | 覆盖临时角色；可重复 | `--role claude=风险审阅者` |
| `--confirm-plan` | 已核对方案，跳过终端确认 | 自动化调用必需 |
| `--interactive` | 启用四个阶段检查点 | 交互终端使用 |
| `--convergence auto\|always\|never` | 争议收敛策略；默认 `auto` | `--convergence never` |
| `--format markdown\|json` | stdout 格式；默认 Markdown | `--format json` |
| `--concurrency N` | 最大并发数；实际限制为 1-6 | `--concurrency 4` |

### `mad resume`

```text
mad resume DELIBERATION_ID [--interactive] [--format markdown|json] [--concurrency N]
```

- `DELIBERATION_ID`：档案目录名中的审议 ID；
- `--interactive`：恢复等待中的交互检查点；
- `--format`：stdout 使用 Markdown 或 JSON；
- `--concurrency`：最大并发数，限制为 1-6。

### `mad serve`

```text
mad serve [--port 8080] [--no-open]
```

- `--port`：本机监听端口，默认 `8080`；
- `--no-open`：启动后不自动打开浏览器。

### `mad clean-temp`

```text
mad clean-temp [--yes]
```

- 默认列出候选项并二次确认；
- `--yes` 跳过确认；
- 活动中或可恢复审议使用的快照始终受保护；
- 该命令不会删除审议档案。

## 5. Coding Agent 集成

### 5.1 Codex 示例提示

```text
在当前仓库执行一次只读多 Agent 架构审议。运行：
mad deliberate "检查这个改动的架构风险、最强反例和回滚条件" \
  --workspace . \
  --agents codex,claude \
  --report-agent codex \
  --confirm-plan \
  --format json

不要合并 stdout 与 stderr。解析 stdout JSON；若退出码非 0，报告 stderr 和审议 ID，不要猜测结果。
```

### 5.2 Claude Code 示例提示

```text
请调用本机 mad 对当前项目做只读审议：
mad deliberate "比较候选实现并指出证据不足之处" \
  --workspace . \
  --agents claude,codex \
  --report-agent claude \
  --convergence auto \
  --confirm-plan \
  --format json

只把 stdout 当作结果 JSON；stderr 仅作为进度和诊断。根据退出码处理失败，不要自动改用 --direct-workspace。
```

退出码：

| 退出码 | 含义 | 调用方处理 |
|---:|---|---|
| `0` | 成功，包括带警告完成 | 解析 stdout |
| `1` | 工作流、恢复或最终报告失败 | 展示 stderr；若状态可恢复，保留审议 ID |
| `2` | 参数、方案或配置错误 | 修正调用，不重试同一参数 |
| `3` | 可用参与者不足 | 检查 `mad agents`、认证和预检 |
| `130` | 用户取消或终止信号 | 不当作模型结论；可按审议 ID 恢复 |

## 6. DevUI

```bash
mad serve
mad serve --port 8090 --no-open
```

未配置 `DEVUI_AUTH_TOKEN` 时，终端会先显示本次进程使用的随机 Token：

```text
DevUI Bearer Token（仅本机使用，请勿分享）：
<随机 Token>
INFO:     Uvicorn running on http://127.0.0.1:8080
```

浏览器出现 `Authentication Required` 后，将该 Token 粘贴到输入框并连接。此时 `/meta` 返回 `401 Unauthorized`
表示浏览器尚未携带有效 Token，并不表示服务启动失败。若终端没有显示 Token：

1. 检查是否显式设置了 `DEVUI_AUTH_TOKEN`；设置后 MAD 会使用该值，但不会把已有密钥重新打印到日志；
2. 如果刚从本地源码升级，执行 `uv tool install --force --reinstall-package multi-agent-decision .`，避免 uv
   复用同版本号的旧构建；
3. 重新运行 `mad serve`。

固定安全边界：

- 应用始终绑定 `127.0.0.1`，CLI 不提供 `--host`；
- Bearer Token 认证始终启用；未显式配置时，启动日志生成并显示随机 Token；
- 浏览器页面可自动打开，`--no-open` 只关闭自动打开，不关闭认证；
- 不要使用反向代理、端口转发、隧道或容器端口映射把 DevUI 暴露到局域网或公网；
- DevUI 是本地开发与调试工具，不承诺多用户、远程访问或生产可用性。

DevUI 新审议会先显示最终方案确认，再进入四个引导检查点。进程丢失后，可以在启动表单中填写 `resume_id` 重新打开持久化检查点。

## 7. 数据、恢复与清理

```text
~/Library/Application Support/MultiAgentDecision/
├── config/agents.toml
├── deliberations/<审议ID>/
│   ├── metadata.json
│   ├── plan.json
│   ├── state.json
│   ├── transcript.jsonl
│   ├── events.jsonl
│   ├── diagnostics.jsonl
│   ├── report.md
│   └── result.json
├── logs/
└── temp/
```

- `transcript.jsonl` 是完整正式记录，不因摘要而裁剪；
- `events.jsonl` 包含指导、阶段提交、争议覆盖和统一摘要等审计事件；
- `diagnostics.jsonl` 包含预检、调用错误和未完成阶段的部分输出；
- 正常完成后删除材料快照；
- 取消或异常后保留 `.mad-recoverable` 快照，恢复完成后再删除；
- `mad clean-temp` 跳过 `.mad-active` 和 `.mad-recoverable`。

## 8. 故障排查

### 找不到 `mad`

```bash
uv tool update-shell
uv tool install --force .
```

重开终端后运行 `mad --help`。

### 没有可用 Agent 或预检后不足两个

```bash
mad agents
```

检查对应 CLI 是否在 `PATH`、是否完成认证、模型 ID 是否存在，以及 `enabled = true`。修改 `agents.toml` 后重新启动命令或 DevUI。

### 项目模式被拒绝

适配器必须证明最低只读约束。Codex、Claude Code、Grok、Pi、CodeBuddy 和 Agy 支持项目只读模式；Agy 固定使用 `--mode plan --sandbox`。Reasonix 当前只支持纯文本审议。不要为了绕过预检自动切换到 `--direct-workspace`。

### Agy 找不到模型或无法启动

```bash
agy --version
agy agents
agy models
```

`model` 必须使用 `agy models` 或 `agy agents` 显示的完整名称，例如 `Gemini 3.5 Flash (Low)`。Agy 会写入自己的日志并启动 localhost 语言服务；请先在普通终端完成认证和首次工作目录信任。MAD 不会传入 `--dangerously-skip-permissions`。

### Pi 多模型找不到模型

```bash
PI_OFFLINE=1 pi --list-models deepseek
PI_OFFLINE=1 pi --list-models minimax
```

把 `agents.toml` 的 `model` 改为列表显示的精确 `provider/model`，并在 Pi 自己的配置中完成认证。不要把 API Key 写入 MAD 注册表。

### 等待检查点，恢复时报必须启用交互模式

```bash
mad resume <审议ID> --interactive
```

### 摘要或阶段失败后状态为“可恢复”

查看档案中的 `metadata.json`、`state.json` 和 `diagnostics.jsonl`。修复认证、模型、预算或暂时性错误后运行 `mad resume`；不要手动拼接部分阶段输出。

### DevUI 返回 401

使用本次启动日志显示的 Token，并按 `Authorization: Bearer <token>` 发送 API 请求。每次未指定固定 Token 的启动都可能生成新值。

### 临时目录占用空间

先运行 `mad clean-temp` 查看候选，再确认清理。活动或可恢复快照不会出现在可清理列表中。

## 9. 可选真实适配器冒烟

实机冒烟会调用已认证模型并可能产生费用，必须显式确认，且至少指定两个 Agent：

```bash
uv run python scripts/smoke_adapters.py \
  --agents pi-deepseek,pi-minimax \
  --report-agent pi-deepseek \
  --confirm-live
```

传入 `--workspace PATH` 时还会验证项目只读能力。脚本不会在缺少 `--confirm-live` 时发起模型调用。
