# Pi Coding Agent — 模型与参数信息

## 基本信息

- **工具名称：** Pi Coding Agent (`@earendil-works/pi-coding-agent`)
- **定位：** 极简终端编码代理（terminal coding harness）
- **安装：** `npm install -g @earendil-works/pi-coding-agent`
- **配置文件：** `~/.pi/agent/settings.json`（全局）、`.pi/settings.json`（项目）

---

## 当前环境可用模型（`pi --list-models`）

```
provider  model                   context  max-out  thinking  images
deepseek  deepseek-v4-flash       1M       384K     yes       no
deepseek  deepseek-v4-pro         1M       384K     yes       no
minimax   MiniMax-M3              1M       128K     yes       yes
minimax-cn MiniMax-M3             1M       128K     yes       yes
```

| Provider | Model | Context Window | Max Output | Thinking | Images |
|----------|-------|---------------|-----------|----------|--------|
| deepseek | deepseek-v4-flash | 1M | 384K | 支持 | 不支持 |
| deepseek | deepseek-v4-pro | 1M | 384K | 支持 | 不支持 |
| minimax | MiniMax-M3 | 1M | 128K | 支持 | 支持 |
| minimax-cn | MiniMax-M3 | 1M | 128K | 支持 | 支持 |

---

## 思考等级 (Thinking Levels)

共 **7 个** 级别（从低到高）：

| 级别 | 含义 |
|------|------|
| `off` | 关闭思考 |
| `minimal` | 最简思考 |
| `low` | 低强度思考 |
| `medium` | 中等思考 |
| `high` | 高强度思考 |
| `xhigh` | 超高思考 |
| `max` | 最大思考 |

### 使用方式

| 方式 | 示例 |
|------|------|
| CLI 参数 | `pi --thinking high` |
| 模型简写 | `pi --model deepseek-v4-pro:high` |
| 交互模式快捷键 | `Shift+Tab` 循环切换 |
| 设置面板 | `/settings` |
| 全局配置 | `settings.json` 中 `defaultThinkingLevel` |

### 自定义 Token 预算

可在 `settings.json` 中按级别分配 token 预算：

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

> 注：不是所有模型都支持全部 7 个等级。通过 `models.json` 的 `thinkingLevelMap` 可以精确控制每个等级到模型参数的映射，用 `null` 隐藏不支持的等级。

---

## 自定义模型（`~/.pi/agent/models.json`）

Pi 支持添加兼容 OpenAI / Anthropic / Google API 的自定义模型，最小配置：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b", "reasoning": true }
      ]
    }
  }
}
```

关键模型字段：

| 字段 | 必需 | 默认 | 说明 |
|------|------|------|------|
| `id` | 是 | — | 模型标识符（发往 API） |
| `name` | 否 | `id` | 可读名称，用于 `--model` 匹配 |
| `reasoning` | 否 | `false` | 是否支持扩展思考 |
| `thinkingLevelMap` | 否 | — | 思考等级到模型参数的映射 |
| `input` | 否 | `["text"]` | `["text"]` 或 `["text", "image"]` |
| `contextWindow` | 否 | `128000` | 上下文窗口（tokens） |
| `maxTokens` | 否 | `16384` | 最大输出 tokens |
| `cost` | 否 | 全零 | 每百万 token 价格 |

文件修改后即时生效，无需重启。

---

## 内置提供商列表

Pi 内置支持以下提供商的 API Key 或订阅认证：

| 提供商 | 认证方式 |
|--------|---------|
| Anthropic | API Key / 订阅 (Claude Pro/Max) |
| OpenAI / Azure OpenAI | API Key / 订阅 (ChatGPT Plus/Pro) |
| Google Gemini / Vertex | API Key |
| DeepSeek | API Key |
| GitHub Copilot | 订阅 (OAuth) |
| Groq / Cerebras / Mistral | API Key |
| xAI | API Key |
| OpenRouter | API Key |
| NVIDIA NIM | API Key |
| Vercel AI Gateway | API Key |
| Cloudflare AI Gateway / Workers AI | API Key |
| Fireworks / Together AI | API Key |
| Kimi For Coding / MiniMax / 小米 MiMo | API Key |
| ZAI Coding Plan | API Key |
| OpenCode Zen/Go | API Key |
| Hugging Face | API Key |
| 蚂蚁灵 (Ant Ling) | API Key |

---

## 常用 CLI 参数速查

```bash
# 列出所有可用模型
pi --list-models

# 搜索模型
pi --list-models claude

# 指定模型
pi --provider deepseek --model deepseek-v4-pro

# 模型+思考等级简写
pi --model deepseek-v4-pro:high "解决这个复杂问题"

# 指定思考等级
pi --thinking high "分析这个代码库"

# 只允许只读工具
pi --tools read,grep,find,ls -p "审查代码"

# 查看所有快捷键
/hotkeys
```

---

## 交互模式常用快捷键

| 快捷键 | 操作 |
|--------|------|
| `Ctrl+L` | 打开模型选择器 |
| `Ctrl+P` / `Shift+Ctrl+P` | 前后循环切换已启用模型 |
| `Shift+Tab` | 循环切换思考等级 |
| `Ctrl+O` | 折叠/展开工具输出 |
| `Ctrl+T` | 折叠/展开思考块 |
| `Ctrl+G` | 外部编辑器 |
| `Esc` | 取消/中止 |
| `Esc Esc` | 打开会话树 (`/tree`) |

---

## 模型循环列表

在 `settings.json` 中配置：

```json
{ "enabledModels": ["deepseek-*", "MiniMax-*"] }
```

交互模式下用 `/scoped-models` 开关此功能。

## Models.dev 核验

| Pi 模型 | Context | Max output | 核验结果 |
|---|---:|---:|---|
| `deepseek/deepseek-v4-flash` | 1,000,000 | 384,000 | 与 Models.dev 规范页及 DeepSeek provider 行一致 |
| `deepseek/deepseek-v4-pro` | 1,000,000 | 384,000 | 与 Models.dev 规范页及 DeepSeek provider 行一致 |
| `minimax-cn/MiniMax-M3` | 1,000,000 | 128,000 | 中国区真实 READY 预检通过；规范页默认 Context 为 512,000 |

Pi 的 `--list-models` 同时显示 `minimax` 和 `minimax-cn`。本机 API Key 注册在 `minimax-cn`，MAD 因此必须使用 `minimax-cn/MiniMax-M3`；用国际站前缀会命中不同端点并返回 401。MiniMax-M3 的 1M 值可以保留，但必须标注为 provider 特定限制。详见 [Models.dev 核验记录](../models-dev核验.md)。

对于 DeepSeek V4，Pi 的七档属于客户端抽象：DeepSeek 官方 Pi 示例把 `minimal`、`low`、`medium`、`high` 都映射为后端 `high`，把 `xhigh` 映射为 `max`；因此七档不代表后端有七种不同推理强度。
