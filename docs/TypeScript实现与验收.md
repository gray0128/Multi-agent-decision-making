# TypeScript 实现与接管验收

> 状态：2026-07-21 完成整体接管。本文记录 [TypeScript 目标架构](TypeScript目标架构.md) 的实现与验收证据；与目标架构或 ADR 冲突时，以目标架构和 ADR 为准。

## 已实现范围

- 单个 npm 包，Node.js 22+，`mad` 可执行入口；
- `clis.toml` 严格 schema、可信调用预设、`init` / `config validate` / `config check`；
- Codex、Claude Code、Reasonix、Grok、Pi、CodeBuddy、`agy` 类型化适配器；
- 固定组局、方案确认/修改/重新组局、唯一调用组合预检；
- 结构化审议的阶段屏障、争议信号、一次收敛与共同成果流水线；
- 自由讨论的覆盖周期、主持窗口规划、逐回合提交、收敛评估与结束讨论；
- 全局及 CLI 级并发限制、调用次数/超时/上下文预算、统一滚动摘要；
- 透明档案、逻辑调用冻结、尝试诊断、幂等提交、暂停/取消和恢复；
- 固定监听 `127.0.0.1` 的认证观察服务、SSE、静态观察页和一次性检查点文件信箱；
- 纯文本空白 scratch 目录和显式项目目录完整只读授权；
- Markdown/JSON stdout 契约、stderr 进度与分状态退出码。

## 自动验证

验收命令：

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

2026-07-21 结果：

| 验证 | 结果 |
|---|---|
| TypeScript 类型检查 | 通过 |
| Vitest | 13 个测试文件、44 个测试全部通过 |
| TypeScript 构建 | 通过 |
| npm 打包 dry-run | 通过，包内只包含 `dist`、`README.md` 和 `package.json` |
| 配置静态校验 | 7 个 CLI，默认组局器 `codex/sol-medium`，通过 |

测试覆盖：

- 严格配置与安全参数拒绝；
- 七个适配器的固定权限/工具参数和公开文本解析；
- 固定组局、共享来源、项目只读能力门禁；
- 结构化审议与自由讨论控制器；
- 统一摘要、逻辑调用恢复、Ctrl-C 中断边界；
- 原子档案、活动锁回收、一次性检查点竞争；
- 观察服务认证、历史读取和响应写入边界；
- CLI 结构化/自由讨论单行 JSON 端到端、失败后恢复、无 TTY 观察服务 guided 模式。

真实验收还发现并修复了一个仅靠模拟测试未覆盖的问题：Pi 在后端认证失败时可能以退出码 0 输出 JSON 错误事件。适配器现在不会再把 JSONL 中的用户提示误判为模型公开回答，并会提取、脱敏和上报 `errorMessage`。

## 真实 CLI 接管

在隔离的 `.mad-ts-local` 数据根中，使用用户明确填写并通过模型规格核验的 `clis.toml` 执行：

```bash
MAD_HOME="$PWD/.mad-ts-local" node dist/cli/index.js config check
```

最终结果：

```text
配置有效，12 个调用组合预检通过。
```

通过组合：

| CLI | 调用预设 |
|---|---|
| Codex | `terra-medium`、`sol-medium` |
| Claude Code | `sonnet-high` |
| Reasonix | `deepseek-v4-pro`、`deepseek-v4-flash` |
| Grok | `grok-4-5-high` |
| Pi | `deepseek-v4-pro-high`、`deepseek-v4-flash-high`、`minimax-m3-high` |
| CodeBuddy | `hy3`、`kimi-k3-2` |
| AGY | `gemini-3-5-flash-low` |

Pi 同时列出国际站 `minimax/MiniMax-M3` 与中国区 `minimax-cn/MiniMax-M3`。本机凭证注册在 `minimax-cn`，因此有效预设使用后者；其 1,000,000 Context、128,000 Max output 与当前 Pi 模型目录一致。错误使用国际站 ID 时返回的零退出码 JSON `401 invalid api key` 也已验证会被 MAD 准确识别为失败。

Reasonix 已完成纯文本真实预检，但其当前版本没有可由 MAD 固定启用并验证的只读开关，且本机记录为 `sandbox.bash = off`。因此适配器继续在项目模式门禁中拒绝 Reasonix；这属于明确的安全能力边界，不是未完成迁移。

## 整体接管结论

目标架构第 17 节的实现顺序与接管门槛已经满足：

1. 单包 TypeScript 基础、配置、档案和 CLI 已实现；
2. Codex 纵向路径与资源默认值已验证；
3. 结构化审议已实现并通过端到端测试；
4. 自由讨论、主持窗口与共享报告流水线已实现并通过端到端测试；
5. 本地观察服务、认证、历史页面、SSE 和检查点信箱已验证；
6. 七个 CLI 适配器均完成真实预检；
7. 纯文本、项目只读门禁、恢复、取消、机器输出和安全测试均通过；
8. 用户文档已切换到 TypeScript 单一路径。

仓库已移除 Python 源码、Python 测试、`pyproject.toml`、`uv.lock`、Microsoft Agent Framework 和旧 DevUI。用户应用数据目录中的旧配置和档案没有被读取、迁移、展示或删除。
