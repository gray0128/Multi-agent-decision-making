# models.dev 模型规格核验

> 核验日期：2026-07-21（Asia/Shanghai）  
> 核验范围：本目录现有文档中实际出现的底层模型；Agent/CLI 自身的参数枚举以本机采集结果为准。  
> 数据口径：优先采用模型厂商官方资料；[models.dev](https://models.dev/) 用于统一名称、上下文窗口、最大输出与能力标签，并用于发现不同提供商的限制差异。

## 1. 核验结论

| Agent / 接入层 | 文档中的模型或档位 | 对应底层模型 | 上下文窗口 | 最大输出 | 推理支持 / 等级 | 结论 |
|---|---|---|---:|---:|---|---|
| Claude Code | `haiku` | `MiniMax-M3` | 官方直连最高 1,000,000；保证至少 512,000 | 128,000 | 支持推理；Agent 的 `effort` 等级属于 Claude Code 调度层 | 模型别名不是 Anthropic 模型；应按运行时映射核算窗口 |
| Claude Code | `sonnet` / `opus` / `fable` | `MiniMax-M3[1M]`（本机路由名） | 1,000,000 | 128,000 | 同上 | `[1M]` 是接入层变体名，不是 models.dev 的规范模型 ID |
| Pi | `deepseek-v4-flash` | DeepSeek V4 Flash | 1,000,000 | 384,000 | 思考 / 非思考双模式；Pi 再映射通用 thinking level | 与 models.dev、DeepSeek 官方资料一致 |
| Pi | `deepseek-v4-pro` | DeepSeek V4 Pro | 1,000,000 | 384,000 | 思考 / 非思考双模式；Pi 再映射通用 thinking level | 与 models.dev、DeepSeek 官方资料一致 |
| Pi | `minimax-cn/MiniMax-M3` | MiniMax M3 中国区路由 | 1,000,000（512,000 以内为保证档；超出部分受权限/配额约束） | 128,000 | 支持推理 | 本机认证与真实 READY 预检通过；provider 前缀必须与凭证区域一致 |
| Reasonix | `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | 1,000,000 | 384,000 | 主调用未暴露 effort；子任务支持默认 / `high` / `max` | 模型 ID 与官方规格精确匹配；和 Pi 预设共享模型来源 |
| Reasonix | `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | 1,000,000 | 384,000 | 同上 | 模型 ID 与官方规格精确匹配；和 Pi 预设共享模型来源 |
| Grok Build | `grok-4.5` | Grok 4.5 | 500,000 | 官方资料未单列；models.dev 规范值为 500,000 | API 官方等级为 `low` / `medium` / `high`，默认 `high`；CLI 另有更宽枚举 | 500K 上下文已获官方与 models.dev 双重确认；不要把 CLI 等级直接等同于 API 枚举 |
| AGY | `flash` | Gemini 3.5 Flash | 1,048,576 | 65,536 | 支持 thinking；官方迁移文档列出 `minimal` / `low` / `medium` / `high`，默认 `medium` | 与 models.dev、Google 官方资料一致 |
| AGY | `pro` | 文档称 Gemini 3.5 Pro | 未核实 | 未核实 | 未核实 | models.dev 当前目录未检索到该规范模型；更可能是 AGY 产品档位/路由别名，不能据档位名填写模型窗口 |
| AGY | `flash_lite` | 文档称 Gemini 3.5 Flash-Lite | 未核实 | 未核实 | 未核实 | models.dev 当前可核实的是 Gemini 3.1 Flash-Lite（1,048,576 / 65,536）；不能据此推断 3.5 版本 |
| CodeBuddy | `hy3` | Hy3 / 文档可能仍路由 Hy3 preview | 256,000 | models.dev 对 preview 记为 64,000；腾讯公告未给出最大输出 | 支持快慢思考；CodeBuddy 的 `reasoningEffort` 是接入层参数 | 上下文已双重确认；需通过 CodeBuddy 模型元数据确认当前 `hy3` 是否已从 preview 切到正式版 |
| CodeBuddy | `kimi-k3-2` | 推测为 Kimi K3 的平台别名 | 1,048,576 | 131,072 | Kimi 产品帮助页列出 `Low` / `High` / `Max`；CodeBuddy 有自己的通用等级 | models.dev 可核实规范模型 `kimi-k3`，但无法仅凭名称证明 `kimi-k3-2` 的精确映射 |
| Codex | `gpt-5.6-sol` | GPT-5.6 Sol | 1,050,000 | 128,000 | Models.dev 标记支持 reasoning；六档 effort 由当前 Codex 运行环境提供 | 模型 ID 与 Models.dev 精确匹配 |
| Codex | `gpt-5.6-terra` | GPT-5.6 Terra | 1,050,000 | 128,000 | Models.dev 标记支持 reasoning；六档 effort 由当前 Codex 运行环境提供 | 模型 ID 与 Models.dev 精确匹配 |

## 2. 逐模型证据

### 2.1 MiniMax-M3

- [models.dev：MiniMax-M3](https://models.dev/models/minimax/MiniMax-M3/) 的模型级规范值为 **512,000 context / 128,000 output**；同页的 MiniMax 官方提供商行则为 **1,000,000 / 128,000**，并显示各网关可能采用不同限制。
- [MiniMax 官方模型页](https://www.minimax.io/models/text/m3)说明 API **最高支持 1M context，保证至少 512K**。
- [MiniMax 官方 Token Plan](https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise)把 `≤512K` 与 `512K~1M` 分为两个计费/供应区间，并提示超 512K 的能力可能需要额外访问条件。

因此，跨 Agent 汇总时建议写作：**1M 最高 / 512K 保证档 / 128K 最大输出**。若配置文件只能填一个保守值，使用 `512000`；若明确走 MiniMax 官方 1M 路由，可填 `1000000`。

### 2.2 DeepSeek V4 Flash / Pro

- [models.dev：DeepSeek V4 Flash](https://models.dev/models/deepseek/deepseek-v4-flash/)与 [DeepSeek V4 Pro](https://models.dev/models/deepseek/deepseek-v4-pro/)均记录 **1,000,000 context / 384,000 output**，并标记 reasoning、tools、structured output。
- [DeepSeek 官方 Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)给出相同的 **1M context / 最大 384K output**，两款模型均支持 thinking 与 non-thinking。
- [DeepSeek 官方 Pi 集成文档](https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono)直接给出 Pi 配置：`contextWindow: 1000000`、`maxTokens: 384000`。其中 Pi 的 `minimal`、`low`、`medium`、`high` 被映射为后端 `high`，`xhigh` 映射为 `max`，说明 Pi 的七档 UI 并不代表 DeepSeek API 有七个独立推理档位。

这两项是本目录里证据最完整、无规格冲突的模型。

### 2.3 Grok 4.5

- [models.dev：Grok 4.5](https://models.dev/models/xai/grok-4.5/)记录 **500,000 context / 500,000 output**。
- [xAI 官方模型页](https://docs.x.ai/developers/models/grok-4.5)确认 **500,000 context** 和 reasoning 能力，但未在公开摘要中给出独立的最大输出值。
- [xAI Grok 4.5 指南](https://docs.x.ai/developers/grok-4-5)明确 API reasoning 等级为 `low`、`medium`、`high`，默认 `high`。

因此，500K 上下文可标为高置信度；500K 最大输出目前只由 models.dev 支持，应标为中等置信度。Grok Build CLI 探测出的 `none`、`minimal`、`xhigh` 以及 Agent `--effort max` 属于客户端/调度层能力，不能反向推断为 xAI API 的原生枚举。

### 2.4 Gemini 3.5 Flash 与 AGY 档位

- [models.dev：Gemini 3.5 Flash](https://models.dev/models/google/gemini-3.5-flash/)记录 **1,048,576 context / 65,536 output**。
- [Google 官方 Gemini 3.5 Flash 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash)给出完全相同的输入、输出限制，并确认支持 Thinking。
- [Google 官方迁移指南](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5)说明 `thinking_level` 可使用 `minimal`、`low`、`medium`、`high`，且该模型默认值从 `high` 调整为 `medium`。

AGY 文档中的 `pro`、`flash`、`flash_lite` 首先是子 Agent 的资源档位。只有 `flash` 能稳定对应当前公开的 `gemini-3.5-flash`。截至核验日，models.dev 未列出 `gemini-3.5-pro` 或 `gemini-3.5-flash-lite`；目录中可见的相邻型号是 Gemini 3.1 Pro / Flash-Lite，不能用其规格替代 3.5 档位。

### 2.5 Hy3 / Hy3 preview

- [models.dev：Hy3 preview](https://models.dev/models/tencent/hy3-preview/)记录 **256,000 context / 64,000 output**，支持 reasoning 与 tools。
- [腾讯 Hy3 preview 官方公告](https://www.tencent.com/en-us/articles/2202320.html)确认 **最高 256K context**，并说明模型融合快、慢思考。
- [腾讯 Hy3 正式版官方公告](https://www.tencent.com/en-us/articles/2202386.html)同样确认正式版 **最高 256K context**。

CodeBuddy 的 `hy3` 是平台模型 ID，不足以证明其当前后端是 preview 还是正式版。256K 上下文可作为高置信度值；64K 最大输出仅对 models.dev 中的 preview 条目有直接证据。

### 2.6 Kimi K3 / `kimi-k3-2`

- [models.dev：Kimi K3](https://models.dev/models/moonshotai/kimi-k3/)记录 **1,048,576 context / 131,072 output**，支持 reasoning、tools、structured output。
- [Kimi 官方帮助中心](https://www.kimi.com/help/getting-started/overview)把 K3 的思考等级列为 `Low`、`High`、`Max`。

CodeBuddy 文档中的 `kimi-k3-2` 不是 models.dev 的规范模型 ID。除非 CodeBuddy 的 `/model list` 或 `models.json` 同时暴露规范 ID、context 与 max output，否则只能标记为“推测映射到 Kimi K3”，不应直接把 Kimi K3 的规格写成已确认的路由限制。

### 2.7 GPT-5.6 Sol / Terra（Codex）

- [models.dev：GPT-5.6 Sol](https://models.dev/models/openai/gpt-5.6-sol/)与 [GPT-5.6 Terra](https://models.dev/models/openai/gpt-5.6-terra/)均记录 **1,050,000 context / 128,000 output**，支持 reasoning 与 tools。
- 当前 Codex 运行环境公开的模型 ID 与这两个规范 ID 精确一致，并为两者提供 `low`、`medium`、`high`、`xhigh`、`max`、`ultra` 六档 effort。

这里的窗口规格来自 models.dev，六档枚举来自当前 Codex 运行环境；不能据此推断所有 Codex 版本、账号或 OpenAI API 接入都暴露相同枚举。

## 3. 使用这些数据时的口径

1. **Agent 档位不等于模型 ID。** `opus`、`pro`、`hy3` 等名称可能是路由别名；先解析到底层模型，再读取模型规格。
2. **模型规范值不等于提供商限制。** models.dev 的模型页会同时展示模型级值和不同提供商行；运行时应优先使用当前 API 提供商的限制。
3. **Context 与 Output 可能是总量约束。** 即使分别列出 context 和 max output，也不代表两者可同时取满；请求必须服从提供商的输入 + 输出总量规则。
4. **思考等级分两层。** CLI/Agent 的 `effort`、`thinking` 是调度抽象；底层 API 可能只有开/关、较少档位，或需要 token budget。汇总表应分别记录“客户端枚举”和“模型原生能力”。
5. **动态账号目录优先。** Grok、CodeBuddy 等账号可见模型会随订阅和远程目录变化；静态文档用于基线，实际执行前仍应读取 CLI 的实时模型元数据。

## 4. 待补证项

| 项目 | 缺少的证据 | 建议动作 |
|---|---|---|
| AGY `pro` | 规范模型 ID、上下文、最大输出 | 从 AGY 当前会话/配置导出实际 model ID，不把 `pro` 直接展开为 Gemini 3.5 Pro |
| AGY `flash_lite` | 规范模型 ID | 确认是否仍路由 Gemini 3.1 Flash-Lite，或已有未公开的 3.5 变体 |
| CodeBuddy `hy3` | preview / 正式版映射、最大输出 | 保存 `/model list` 的完整元数据或检查 `models.json` |
| CodeBuddy `kimi-k3-2` | 与 `moonshotai/kimi-k3` 的映射关系 | 检查 CodeBuddy 模型定义中的 provider、base URL、context window、max tokens |
| Grok 4.5 最大输出 | xAI 官方独立上限 | 以 `/v1/models/grok-4.5` 的账号实时响应为准；在此之前保留“models.dev 值”标记 |
