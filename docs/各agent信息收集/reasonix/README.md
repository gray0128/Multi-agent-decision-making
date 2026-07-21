# Reasonix Agent

## 概述

Reasonix 是一个编码代理（coding agent），专注于执行代码任务。通过提供的工具读取/写入文件、运行 shell 命令，支持多步骤任务规划与执行。

- **默认模型**: `deepseek/deepseek-v4-pro`
- **配置文件**: `~/.reasonix/config.toml`
- **Provider**: DeepSeek (OpenAI 兼容 API)

---

## 可用模型

| 模型 ID | 类型 | 价格 (¥/1M tokens) | 上下文窗口 | 视觉支持 |
|---|---|---|---|---|
| `deepseek/deepseek-v4-flash` | 快速 | 输入 ¥1 / 输出 ¥2，缓存命中 ¥0.02 | 1,000,000 | ❌ |
| `deepseek/deepseek-v4-pro` | 旗舰 | 输入 ¥3 / 输出 ¥6，缓存命中 ¥0.025 | 1,000,000 | ❌ |

模型调用格式: `provider/model`，例如 `deepseek/deepseek-v4-pro`。

---

## Agent 参数

| 参数 | 当前值 | 说明 |
|---|---|---|
| `temperature` | `0.0` | 生成温度，0 = 确定性输出 |
| `auto_plan` | `on` | 自动进入计划模式 |
| `max_steps` | 0 (无限制) | 单次工具调用轮数上限 |
| `planner_max_steps` | 0 (无限制) | 计划模式只读工具调用轮数上限 |
| `bash_timeout_seconds` | `120` | Shell 命令超时（秒） |
| `soft_compact_ratio` | `0.5` | 软压缩触发比例 |
| `compact_ratio` | `0.8` | 上下文压缩触发比例 |
| `compact_force_ratio` | `0.9` | 强制压缩高水位线 |
| `cold_resume_prune` | `true` | 恢复会话时裁剪过期工具结果 |
| `output_style` | 默认 | 输出风格：`explanatory` / `learning` / `concise` / `custom` |

---

## 一次性调用（CLI 模式）

Reasonix 支持多种一次性/非交互调用模式，适用于脚本、CI/CD、API 服务等场景。

### 调用模式总览

```
reasonix                                               交互式会话（多轮）
reasonix run [flags] <task>                             执行单次任务后退出（一次性）
reasonix review [flags]                                 AI 代码审查（基于本地 diff，一次性）
reasonix serve [flags]                                  通过 HTTP+SSE 提供服务（持久化 API）
reasonix acp [flags]                                    通过 stdio 提供 Agent Client Protocol
reasonix bot start                                      多渠道 IM bot 网关（QQ/飞书/微信）
```

### `reasonix run` — 一次性任务执行（最常用）

```bash
reasonix run [flags] "<task>"
echo "解释这段代码" | reasonix run     # 支持管道输入
```

| 参数 | 说明 |
|---|---|
| `--model <name>` | 覆盖默认模型，如 `--model deepseek/deepseek-v4-flash` |
| `--max-steps <N>` | 最大工具调用轮数（0 = 使用配置值，默认无限制） |
| `--dir <path>` | 切换到指定目录执行（项目根目录），沙箱和文件工具基于此路径解析 |
| `--continue` / `-c` | 恢复最近一次保存的会话（有状态连续执行） |
| `--resume <path>` | 恢复指定的会话文件（非交互，优先级高于 --continue） |
| `--metrics <path>` | 执行结束后将 token/cache/cost 摘要写入 JSON 文件 |
| `--show-thinking` | 展开显示思考文本（默认折叠） |

**示例：**

```bash
# 基础一次性调用
reasonix run "把 main.go 里的 TODO 实现掉"

# 指定模型 + 限制步数
reasonix run --model deepseek/deepseek-v4-flash --max-steps 10 "给这个函数补单元测试"

# 指定工作目录
reasonix run --dir /path/to/project "分析项目结构"

# 输出用量摘要
reasonix run --metrics ./metrics.json "重构 auth 模块"

# 管道输入
echo "解释这段代码的作用" | reasonix run

# 继续上次会话
reasonix run -c "继续上一个任务"
```

### `reasonix review` — 一次性代码审查

```bash
reasonix review [flags]
```

| 参数 | 说明 |
|---|---|
| `--model <name>` | 覆盖默认模型 |
| `--base <branch/commit>` | 对比的基准分支/提交（默认 HEAD，即审查未提交的工作区变更） |
| `--commit <SHA>` | 审查某个特定提交的变更 |
| `--instructions <text>` | 附加审查指令，追加到 prompt 末尾 |

**示例：**

```bash
# 审查当前工作区变更
reasonix review

# 审查某个提交
reasonix review --commit abc1234

# 审查分支差异
reasonix review --base main

# 带自定义审查指令
reasonix review --instructions "重点关注 SQL 注入和 XSS 漏洞"
```

### `reasonix serve` — HTTP API 服务

```bash
reasonix serve [flags]
```

| 参数 | 说明 |
|---|---|
| `--model <name>` | 默认模型 |
| `--max-steps <N>` | 最大工具调用轮数 |
| `--addr <host:port>` | 监听地址（默认 `127.0.0.1:8787`） |
| `--auth <mode>` | 认证模式：`none` / `token` / `password`（默认 `none`） |
| `--token <str>` | 预共享 token（auth=token 时使用，留空自动生成） |
| `--password <str>` | 密码（auth=password 时使用） |
| `--hash-password` | 打印 --password 的 bcrypt 哈希并退出 |
| `--behind-proxy` | 信任反向代理的 X-Forwarded-For / X-Forwarded-Proto 头 |
| `--resume <path>` | 恢复已保存的会话文件 |

### `reasonix acp` — Agent Client Protocol (stdio)

```bash
reasonix acp [--model <name>]
```

通过标准输入/输出提供 ACP 协议服务，适合嵌入到其他进程中。

### Bot 网关（一次性/事件驱动调用）

Bot 模式下每次消息触发一次独立的 agent 调用：

| 参数 | 当前值 | 说明 |
|---|---|---|
| `bot.enabled` | `false` | 是否启用 Bot 网关 |
| `bot.model` | (空=默认模型) | 可单独指定 Bot 使用的模型 |
| `bot.max_steps` | `25` | 每次消息的最大工具调用轮数 |
| `bot.tool_approval_mode` | `ask` | 工具审批模式：`ask` / `auto` / `yolo` |
| `bot.debounce_ms` | `1500` | 消息去抖间隔（毫秒） |

---

## 无交互/无头配置

在一次性和自动化场景中，需要关闭交互式确认：

### 权限模式（`[permissions]`）

| 配置 | 当前值 | 可用值 | 说明 |
|---|---|---|---|
| `mode` | `ask` | `ask` / `allow` / `deny` | 写操作默认行为。一次性和自动化场景建议设为 `allow` |
| `deny` | (未设) | 如 `["Bash(rm -rf*)"]` | 硬阻止列表，所有模式下生效 |
| `allow` | (未设) | 如 `["Bash(go test:*)"]` | 免确认白名单 |
| `ask` | (未设) | 如 `["Edit(src/**)"]` | 强制询问列表（即使 mode=allow） |

```toml
# 一次性/自动化推荐配置
[permissions]
mode = "allow"
deny = ["Bash(rm -rf*)", "Bash(git push --force*)"]
```

### 审批模式对照

| 场景 | 推荐配置 |
|---|---|
| 交互式开发 | `permissions.mode = "ask"`（当前） |
| CI/CD 自动化 | `permissions.mode = "allow"` + deny 关键危险操作 |
| API 服务 | `reasonix serve --auth token` + `permissions.mode = "allow"` |
| Bot 消息响应 | `bot.tool_approval_mode = "auto"` 或 `"yolo"` |

`ask` = 每次写操作弹窗确认；`auto` = 在 YOLO 模式下自动批准；`yolo` = 跳过所有审批。

---

## 思考等级 (effort)

在 `task`、`parallel_tasks`、`read_only_task` 等子任务工具中可用：

| 值 | 含义 |
|---|---|
| (不传) | 默认推理深度 |
| `"high"` | 较高推理深度，适合复杂分析和设计 |
| `"max"` | 最大推理深度，适合深度思考的困难问题 |

---

## 子代理配置（未启用，可选）

以下配置可在 `config.toml` 的 `[agent]` 段中取消注释以启用：

```toml
# planner_model = "deepseek-pro"          # 计划器专用模型
# subagent_model = "deepseek-pro"         # 子代理默认模型
# subagent_models = { review = "deepseek-pro", security_review = "deepseek-pro" }
# subagent_effort = "high"                # 子代理默认思考等级
# subagent_efforts = { review = "max", task = "high" }
```

---

## 核心工具

### 文件操作
- `read_file` — 读取文件内容
- `write_file` — 写入文件
- `edit_file` — 精确替换文件中的字符串
- `multi_edit` — 原子化多步编辑
- `delete_range` / `delete_symbol` — 删除代码范围/符号
- `move_file` — 移动/重命名文件
- `glob` — 文件匹配搜索
- `grep` — 正则搜索（ripgrep）
- `ls` — 列出目录

### 代码理解
- `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_diagnostics` — LSP 语义分析
- `code_index` — 轻量符号索引

### Shell 执行
- `bash` — 执行 shell 命令（前台/后台）

### 任务编排
- `task` / `parallel_tasks` — 派生子代理任务
- `read_only_task` — 只读研究子代理
- `explore` / `research` / `review` / `security_review` — 专项子代理
- `todo_write` — 多步骤任务跟踪
- `complete_step` — 步骤完成签名

### 记忆与技能
- `memory` / `remember` / `forget` — 持久记忆管理
- `run_skill` / `read_skill` / `install_skill` — 技能系统
- `slash_command` — 斜杠命令

### 会话与历史
- `list_sessions` / `read_session` — 会话管理
- `history` — 历史搜索

### 网络
- `web_fetch` — HTTP 请求

### 交互
- `ask` — 向用户提问（多选）

---

## 权限与沙箱

| 配置 | 当前值 | 说明 |
|---|---|---|
| `permissions.mode` | `ask` | 写操作默认询问确认 |
| `sandbox.bash` | `off` | 未启用 OS 级别沙箱 |
| `sandbox.network` | `true` | 允许网络访问 |
| `sandbox.workspace_root` | (当前目录) | 文件写入限制范围 |

---

## UI 配置

| 配置 | 当前值 |
|---|---|
| 语言 | `zh` (中文) |
| 桌面布局 | `workbench` |
| 桌面主题 | `light` |
| 关闭行为 | `background` (最小化到后台) |
| 状态栏 | 显示 model / workspace / git_branch / tokens / cost 等 |

---

## 网络

| 配置 | 当前值 |
|---|---|
| `proxy_mode` | `auto` (跟随环境变量) |
| `proxy.type` | `socks5` |

---

## 更新时间

2026-07-21

---

## Models.dev 核验与 MAD 接入结论

| Reasonix 模型 | Context | Max output | 核验结果 |
|---|---:|---:|---|
| `deepseek/deepseek-v4-pro` | 1,000,000 | 384,000 | 与 Models.dev 和 DeepSeek 官方资料一致 |
| `deepseek/deepseek-v4-flash` | 1,000,000 | 384,000 | 与 Models.dev 和 DeepSeek 官方资料一致 |

- `reasonix run --help` 已确认支持 `--model`、`--dir` 和 `--max-steps`，与 MAD 适配器的调用方式一致。
- Reasonix 的主调用没有独立 effort 参数；文中的 `high` / `max` 属于子任务工具控制，不写入 MAD 调用预设。
- 当前 `sandbox.bash = off`，且 CLI 没有只读运行开关。MAD 因此只允许 Reasonix 参与纯文本审议，不允许它读取项目工作区。
- Reasonix 与 Pi 中相同的 DeepSeek V4 模型属于共享底层来源，不能把二者一致意见表述为独立模型交叉验证。

详细外部证据见 [Models.dev 核验记录](../models-dev核验.md)。
