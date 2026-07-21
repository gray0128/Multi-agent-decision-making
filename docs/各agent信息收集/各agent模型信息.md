# 各 Agent 模型信息总览

> 核验日期：2026-07-21。模型能力以 [Models.dev](https://models.dev/) 的规范模型页和 provider 行为外部参照；CLI 可见名称、账号权限和本机配置以各子目录的实测记录为准。

## 口径说明

- **CLI 模型名**回答“本机调用时写什么”；**规范模型 ID**回答“它对应哪个公开模型”。两者只有在存在明确映射时才合并。
- Models.dev 首页的 Context / Output 是规范模型值；不同 provider 可能覆盖这些限制。因此配置 MAD 时优先采用实际 CLI 或 provider 返回的限制，并把较小值作为安全预算。
- `reasoning effort`、`thinking level` 是 CLI 控制面，不等同于模型上下文或输出上限；Models.dev 的 `Reasoning: Yes` 只证明模型支持推理，不证明 CLI 支持全部等级。
- `—` 表示当前材料不足，不猜测映射或规格。

## 汇总表

| Agent | CLI 可用模型 / 档位 | 规范模型或候选 | Context | Max output | 推理控制 | 核验结论 |
|---|---|---|---:|---:|---|---|
| AGY | `Gemini 3.5 Flash` | `google/gemini-3.5-flash` | 1,048,576 | 65,536 | Off/Minimal、Low、Medium、High | 精确匹配 |
| AGY | `Gemini 3.5 Pro` | — | — | — | 同上 | Models.dev 未找到同名规范模型，保留 CLI 实测但不填规格 |
| AGY | `Gemini 3.5 Flash-Lite` | — | — | — | 同上 | Models.dev 未找到同名规范模型，不能用 3.1 Flash Lite 代填 |
| Codex | `gpt-5.6-sol` | `openai/gpt-5.6-sol` | 1,050,000 | 128,000 | low、medium、high、xhigh、max、ultra | 当前 Codex 运行环境与 Models.dev 精确匹配 |
| Codex | `gpt-5.6-terra` | `openai/gpt-5.6-terra` | 1,050,000 | 128,000 | low、medium、high、xhigh、max、ultra | 当前 Codex 运行环境与 Models.dev 精确匹配 |
| Claude Code | `haiku` → `MiniMax-M3` | `minimax/MiniMax-M3` | 512,000 保证档 | 128,000 | low、medium、high、xhigh、max | MiniMax 官方最高可到 1,000,000，但超过 512K 受路由/访问条件影响 |
| Claude Code | `sonnet` / `opus` / `fable` → `MiniMax-M3[1M]` | `minimax/MiniMax-M3` 的 1M 路由 | 1,000,000 | 128,000 | 同上 | provider 特定值，不应写成规范模型统一值 |
| Grok | `grok-4.5` | `xai/grok-4.5` | 500,000 | 500,000* | reasoning: none～xhigh；agent effort: low～max | Context 获 xAI 与 Models.dev 双证；Output 仅获 CLI 缓存与 Models.dev 支持 |
| Pi | `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | 1,000,000 | 384,000 | off、minimal、low、medium、high、xhigh、max | 精确匹配 |
| Pi | `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | 1,000,000 | 384,000 | 同上 | 精确匹配 |
| Pi | `minimax-cn/MiniMax-M3` | `minimax/MiniMax-M3` 的中国区 provider 路由 | 1,000,000 | 128,000 | 同上 | 本机认证与真实 READY 预检通过；高于规范 Context 512,000 |
| Reasonix | `deepseek/deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | 1,000,000 | 384,000 | 子任务 effort: 默认、high、max | 模型精确匹配；只能参与纯文本审议 |
| Reasonix | `deepseek/deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | 1,000,000 | 384,000 | 同上 | 模型精确匹配；只能参与纯文本审议 |
| CodeBuddy | `hy3` | 候选：`tencent/hy3-preview` | — | — | low、medium、high、xhigh | 别名未获明确映射；候选规范值 256,000 / 64,000 仅供核对 |
| CodeBuddy | `kimi-k3-2` | 候选：`moonshotai/kimi-k3` | — | — | low、medium、high、xhigh | 别名未获明确映射；候选规范值 1,048,576 / 131,072 仅供核对 |

## 文档索引

- [AGY：模型与思考等级](agy/模型与思考等级.md)
- [Codex：模型与思考等级](codex/模型与思考等级.md)
- [Claude Code：模型与思考等级](claudecode/模型与思考等级.md)
- [Grok：模型与思考等级](grok/模型与思考等级.md)
- [Pi：模型与参数信息](pi/pi-模型与参数信息.md)
- [Reasonix：模型与运行参数](reasonix/README.md)
- [CodeBuddy：模型与思考等级](codebuddy/模型与思考等级.md)
- [Models.dev 核验记录](models-dev核验.md)

## 对 MAD 配置的建议

- `context_budget` 使用当前 provider / CLI 的已验证值，并预留系统提示、工具结果和报告阶段空间；不直接填满模型窗口。
- CodeBuddy 两个别名在拿到 `/model list` 的完整元数据或 `models.json` 映射前，不据候选规范值设置硬上限。
- AGY 的 `Gemini 3.5 Pro` 与 `Gemini 3.5 Flash-Lite` 先以 `agy models` / `agy agents` 的完整名称为准；外部规格保持未知。
- Reasonix 与 Pi 的 DeepSeek 预设共享同一底层模型来源，不作为独立模型交叉验证；Reasonix 当前只用于纯文本审议。
- 同一基础模型经不同 CLI 或 provider 接入时仍视为共享模型来源，不能把一致意见描述为独立模型交叉验证。

\* Grok 4.5 的 500,000 最大输出尚未在 xAI 公开模型页获得独立确认，配置时应以账号实时模型元数据为准。
