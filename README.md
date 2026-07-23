# Multi Agent Decision

本地、可审计、可恢复的多 Agent 审议工具。`mad` 通过用户已经安装并认证的 AI CLI 执行一次性非交互调用，支持结构化审议、自由讨论、透明档案和本地审议控制台。

当前实现为 TypeScript 单包架构，支持 Codex、Claude Code、Reasonix、Grok、Pi、CodeBuddy 和 Antigravity CLI（`agy`）。架构与安全边界见 [TypeScript 目标架构](docs/TypeScript目标架构.md)，接管证据见 [TypeScript 实现与验收](docs/TypeScript实现与验收.md)。

## 1. 环境与安装

要求：

- Node.js 22 或更高版本；
- 至少一个已经安装并完成认证的受支持 AI CLI；审议方案本身至少包含两个临时 Agent，它们可以使用不同 CLI，也可以基于同一可信调用预设承担不同角色；
- macOS 为当前完成真实接管验收的平台。

### 1.1 安装发布包（推荐）

优先从 [GitHub Releases](https://github.com/gray0128/Multi-agent-decision-making/releases) 下载 `multi-agent-decision-VERSION.tgz` 及同名 `.sha256`，然后使用绝对路径安装：

```bash
npm install --global /absolute/path/to/multi-agent-decision-VERSION.tgz
command -v mad
mad --help
```

这种方式不需要 clone 仓库，也不依赖本地 TypeScript 构建工具。npm 仍可能从 registry 下载运行时依赖，因此 `.tgz` 不是完全离线安装包。如果发布页同时提供 SHA-256 文件，安装前先核对校验和。

```bash
cd /absolute/path/to/download-directory
shasum -a 256 -c multi-agent-decision-VERSION.tgz.sha256
```

### 1.2 从源码开发

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli/index.js --help
```

在仓库中开发可用：

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js <command>
```

从已构建的 checkout 安装全局命令：

```bash
npm install --global .
mad --help
```

### 1.3 生成发布包

发布者应在干净 checkout 中完成验证和构建后再打包：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack
shasum -a 256 multi-agent-decision-VERSION.tgz > multi-agent-decision-VERSION.tgz.sha256
```

`npm pack` 会生成带版本号的 `.tgz`；发布前用 `npm pack --dry-run` 确认清单包含 `dist/cli/index.js`、`package.json` 和 README。将 tarball 及其 SHA-256 一起上传到发布页。

仓库的 [GitHub Actions 发布流水线](.github/workflows/release.yml) 在推送 `v<package.json version>` 标签时自动执行上述验证，创建 GitHub Release，并上传 `.tgz` 和 `.sha256`。`package.json` 与 `package-lock.json` 版本必须与标签完全一致；带预发布后缀的版本会发布为 prerelease。

```bash
version="$(node -p "require('./package.json').version")"
git tag "v$version"
git push origin "v$version"
```

## 2. 初始化和 CLI 注册表

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js init
```

`mad init` 只完成以下工作：

1. 创建私有的配置、档案和运行时目录；
2. 在 `PATH` 中探测七种 CLI，并在配置中保存稳定命令名，不绑定具体版本目录；
3. 生成 `config/clis.toml` 骨架。

已有配置默认不会被覆盖；`mad init --force` 会显式重建配置骨架，使用前应先备份。初始化不会猜测模型、思考等级或默认组局器。填写真实预设后运行：

```bash
# 只做 schema、引用和枚举校验，不调用模型
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js config validate

# 对每个 CLI/预设发起最小 READY 调用，会使用现有认证并可能产生费用
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js config check
```

配置示例：

```toml
[defaults.generator]
cli = "codex"
preset = "sol-medium"

[[clis]]
id = "codex"
adapter = "codex"
executable = "codex"
timeout_seconds = 300
max_concurrency = 1

[[clis.presets]]
id = "sol-medium"
model = "gpt-5.6-sol"
context_budget = 1000000

[clis.presets.options]
reasoning_effort = "medium"
```

注册表只保存可信的 CLI 执行边界和模型调用预设：

- 不写入 API Key、Token、密码或登录状态；
- 不支持任意 `extra_args`；
- 审议方案只能引用已存在的 `cli/preset`；
- 适配器固定只读、计划模式、工具限制和非持久会话参数；
- 同一 CLI 下的全部预设共享 `max_concurrency` 限流器。

模型窗口和本机预设依据见 [各 Agent 模型信息总览](docs/各agent信息收集/各agent模型信息.md)。

## 3. 发起审议

### 3.1 结构化审议

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js deliberate "评估迁移方案"
```

默认模式为 `structured`，依次执行独立陈述、质疑补充、修订与争议信号、一次争议收敛、报告草拟、并行审阅和最终修订。

### 3.2 自由讨论

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js deliberate \
  "比较两个架构方案" --mode free
```

自由讨论先覆盖每位参与者一次，随后由主持 Agent 按窗口规划发言并评估收敛；结束后复用共同成果流水线。

### 3.3 项目只读审议

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js deliberate \
  "检查当前实现的并发风险" \
  --workspace "$PWD"
```

`--workspace` 是对规范化后完整目录的显式读取授权。项目不会被复制或制作快照；各适配器必须证明最低只读能力。组局候选严格来自 `clis.toml` 中存在的 CLI；如不希望某个 CLI 被选中，应从该配置中移除。Reasonix 当前没有可靠的只读开关，只适合按需配置在不带 `--workspace` 的纯文本审议环境中。

### 3.4 自动与机器输出

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js deliberate \
  "评估发布风险" \
  --auto \
  --auto-confirm-plan \
  --format json
```

- `--auto` 跳过正常阶段检查点；
- `--auto-confirm-plan` 只接受第一次生成且通过校验和预检的方案；
- JSON 模式下 stdout 只有一个完整 JSON 对象；
- 进度、警告和档案路径写入 stderr；
- 失败不会向 stdout 写半截 JSON。

可按次覆盖资源限制；所有值必须为正整数，且不能突破应用安全上限：

| 参数 | 默认值 | 安全上限 | 含义 |
|---|---:|---:|---|
| `--max-participants N` | 5 | 8 | 临时审议 Agent 数量 |
| `--max-calls N` | 60 | 100 | 模型调用尝试总数 |
| `--max-discussion-windows N` | 6 | 12 | 自由讨论检查窗口数 |
| `--timeout-seconds N` | 300 | 1800 | 单次调用超时秒数 |
| `--context-budget N` | 128000 | 1000000 | 单次审议使用的上下文预算 |

最终生效值还会受参与 CLI 的 `timeout_seconds` 和调用预设的 `context_budget` 限制，并写入审议档案供恢复使用。

## 4. 组局和方案确认

每次正式审议前都执行固定组局阶段。默认使用 `clis.toml` 的 `[defaults.generator]`，也可按次覆盖：

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js deliberate \
  "评估实现路径" \
  --organizer codex/sol-medium
```

组局器只能看到注册表安全视图和资源上限，只能选择已有调用预设；在角色适配且资源允许时会优先保持 CLI 来源多样性。交互终端中可以：

- 回车确认；
- 输入完整 JSON 修改参与者、临时角色、报告 Agent 或主持 Agent；
- 使用 `/regroup 指导` 重新组局；
- 使用 `/cancel` 取消。

修改后的方案必须重新校验，新增调用组合必须重新预检。同一 CLI/预设派生的多个角色会保留共享来源标记，不能被表述为独立模型交叉验证。

## 5. 检查点、暂停与恢复

guided 模式在关键阶段等待检查点。终端动作包括：

- 回车继续；
- `/guide 指导内容`；
- `/pause`；
- `/cancel`；
- 自由讨论窗口还支持 `/end`。

第一次 `Ctrl-C` 按可恢复暂停处理，并终止当前 CLI 子进程。恢复命令：

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js resume <审议ID>
```

恢复使用档案中冻结的模式、交互策略、方案、模型预设和预算，不重新组局或切换模型。瞬时错误和 schema 输出错误各自动重试一次；再次失败后保存可恢复状态。

## 6. 审议控制台

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js serve
```

审议控制台：

- 固定监听 `127.0.0.1`；
- 每次启动生成新的 Bearer Token；
- Token 通过 URL fragment 交给页面，只保存在 `sessionStorage`；
- 展示历史、实时状态、已提交正文和当前检查点；
- 提供三步发起向导，先设置审议议题，再生成候选方案，最后配置并确认审议 Agent；
- 只允许从可信 CLI 注册表选择 CLI 与模型调用预设，不允许在页面中修改可执行路径、认证或任意参数；
- 启动独立审议进程，并通过一次性文件信箱转发候选方案校验、确认、重新组局、取消和普通检查点响应。

三步向导的职责边界如下：

1. **设定议题**：填写审议议题，选择结构化审议或自由讨论、guided 或 auto，并按需设置工作目录、组局器和资源上限；
2. **生成方案**：控制服务创建带 `requestId` 的幂等启动记录并派生独立审议进程，由审议进程完成组局和预检；
3. **配置 Agent**：增删候选审议 Agent，为每个 Agent 选择允许的 CLI、模型调用预设和角色，指定报告 Agent 及自由讨论的主持 Agent，再确认、重新组局或取消。

控制台使用 `GET /api/launch-options` 获取经过筛选的安全选项，以 `POST /api/launches` 发起审议，并通过 `GET /api/launches/:requestId` 查询启动结果。重复提交同一 `requestId` 不会重复启动审议。控制服务关闭或重启不会终止已经派生的审议进程；正式状态和档案始终由该独立审议进程写入。

guided 审议在没有交互终端时需要一个在线审议控制台，否则会立即失败而不是无限等待。

## 7. 档案和数据目录

默认应用目录：

```text
macOS: ~/Library/Application Support/MultiAgentDecisionTS/
其他: $XDG_DATA_HOME/multi-agent-decision-ts/
```

可以通过 `MAD_HOME` 使用隔离目录。每次审议包含：

```text
manifest.json      身份、模式、方案和配置快照
state.json         原子更新的恢复状态
events.jsonl       只追加生命周期事件
transcript.jsonl   只追加权威发言
diagnostics.jsonl  脱敏调用诊断
report.md          最终共同成果
```

TypeScript 版不会读取、迁移、展示或删除旧版本产生的 Python 配置和档案。

## 8. 安全边界

- 模型调用只通过参数数组启动子进程，不经过 shell 解析；
- 配置不能覆盖适配器固定的权限、工具、输出和工作目录参数；
- 参与者进程设置 `MAD_PARTICIPANT=1`，禁止递归发起审议；
- stdout/stderr 和诊断记录执行凭证脱敏；
- 审议控制台不支持局域网或公网监听；
- 同一 `MAD_HOME` 同时只允许一个活动审议；
- 审议控制台只写当前用户私有的启动协调记录，不直接写正式档案；候选方案与检查点操作通过一次性文件信箱交给独立审议进程处理。

不要通过反向代理、端口转发或隧道暴露审议控制台，也不要把 CLI 凭证写入 `clis.toml`。

## 9. CLI 命令速查

```text
mad init [--force]
mad config validate
mad config check
mad deliberate "问题" [--mode structured|free] [--workspace PATH]
               [--auto] [--auto-confirm-plan] [--format markdown|json]
               [--organizer CLI/PRESET]
               [--max-participants N] [--max-calls N]
               [--max-discussion-windows N] [--timeout-seconds N]
               [--context-budget N]
mad resume ID [--format markdown|json]
mad serve [--port PORT]
mad --help
```

`mad serve` 默认使用系统分配的空闲端口并自动打开带临时令牌的本地审议控制台；如果系统浏览器无法启动，终端会保留可手动打开的完整地址。`--port` 接受 `0` 到 `65535`，其中 `0` 仍表示自动分配。`resume` 只允许选择输出格式，不能改变原审议的模式、交互策略、方案或预算。

退出码是脚本和 Coding Agent 判断结果的稳定边界：

| 退出码 | 含义 |
|---:|---|
| `0` | 成功 |
| `2` | 命令参数或用法错误 |
| `3` | 配置错误 |
| `4` | CLI 或调用预设预检失败 |
| `5` | 同一 `MAD_HOME` 已有活动审议 |
| `20` | 审议已暂停，可用审议 ID 恢复 |
| `21` | 审议已取消，不可恢复 |
| `30` | 执行或工作流失败 |

## 10. 开发验证

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

生成可发布的安装包时使用 `npm pack`，并对产物生成 SHA-256；`--dry-run` 只验证打包清单，不产生 tarball。

测试覆盖严格配置、七个适配器、固定组局、结构化和自由讨论、并发与上下文、透明档案、恢复和中断、控制台认证、启动幂等、候选方案版本绑定、检查点竞争，以及 HTTP 发起独立进程和 Markdown/JSON CLI 端到端契约。

## 11. 常见问题

### 配置提示模型占位符

`mad init` 不猜测模型。把 `REPLACE_WITH_MODEL_ID`、默认组局器 CLI 和 preset 替换为账号真实可用值，再运行 `config validate`。

### `config validate` 通过但 `config check` 失败

静态验证不访问 CLI。检查对应 CLI 是否已认证、模型 ID 是否属于当前账号，以及 provider 的 API Key 或订阅是否有效。

### 项目审议拒绝 Reasonix

这是安全门禁，不是模型错误。当前 Reasonix 没有可以由 MAD 固定启用并验证的只读运行模式；可将它用于纯文本审议。

### Pi 找不到模型

```bash
PI_OFFLINE=1 pi --list-models deepseek
PI_OFFLINE=1 pi --list-models minimax
```

把配置改为列表中的精确 `provider/model`。若 JSON 事件包含认证错误，即使 Pi 进程退出码为 0，MAD 也会把它识别为调用失败。

### AGY 找不到模型

```bash
agy models
agy agents
```

使用当前 CLI 显示的精确模型 ID，例如 `gemini-3.5-flash-low`。

### guided 模式提示没有交互通道

在交互终端运行，或先启动 `mad serve`。机器调用应使用 `--auto --auto-confirm-plan`。
