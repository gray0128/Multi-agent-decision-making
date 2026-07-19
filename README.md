# Multi Agent Decision

通过 Microsoft Agent Framework 编排本机已安装的 AI CLI，围绕问题开展结构化多 Agent 审议。

详细设计见 [MVP 设计](docs/MVP设计.md)，领域术语见 [CONTEXT.md](CONTEXT.md)。

## 开发环境

```bash
uv sync
uv run mad init
uv run mad deliberate "比较两个方案" --agents codex,claude
```

分析项目时必须显式提供工作目录：

```bash
uv run mad deliberate "检查当前架构风险" --workspace .
```

按需争议收敛默认使用 `auto`：至少两名参与者在修订意见中标记关键未决争议时追加一次收敛轮。也可以显式覆盖：

```bash
uv run mad deliberate "比较两个迁移方案" --convergence always
uv run mad deliberate "快速汇总意见" --convergence never
```

可用策略为 `auto`、`always` 和 `never`；一次审议最多执行一个争议收敛轮。

交互式审议在检查点取消、进程退出或阶段异常后会保留状态与材料快照。使用输出中的审议 ID 从最后一个完整阶段恢复；未完成的并行阶段会由全部参与者重新执行：

```bash
uv run mad deliberate "比较两个迁移方案" --interactive
uv run mad resume <审议ID> --interactive
```

自动模式的未完成审议可省略 `--interactive`。`mad clean-temp` 不会删除活动中或仍可恢复审议使用的快照。

每次新审议都会在执行前展示最终审议方案并要求确认。自动化调用可在核对参数后传入 `--confirm-plan`；组局功能默认关闭，只有显式指定可信注册表中的 Agent 才会启用：

```bash
uv run mad deliberate "评估迁移路径" --organizer codex
uv run mad deliberate "评估迁移路径" \
  --organizer codex \
  --agents codex,claude \
  --report-agent claude \
  --role codex=架构主张者 \
  --role claude=风险审阅者 \
  --confirm-plan
```

组局建议只能引用已启用且预检成功的 Agent 配置。CLI 参数或 DevUI 方案确认响应可修改建议中的参与者、临时角色和报告 Agent；最终确认方案写入审议档案的 `plan.json` 和 JSON 结果。

阶段开始前会按参与者配置的 `context_budget` 估算共享输入。任一参与者预计超限时，报告 Agent 生成一份全员共用摘要；摘要和预算估算写入 `context_summary` 审计事件，原始 `transcript.jsonl` 始终完整保留。摘要失败、摘要输入超过报告 Agent 预算或摘要后仍超限时，审议会暂停为可恢复状态，不会对不同参与者分别裁剪上下文。

## 可选实机适配器冒烟

实机冒烟会调用已认证模型并可能产生费用，因此必须显式确认，且至少指定两个 Agent：

```bash
uv run python scripts/smoke_adapters.py \
  --agents codex,claude \
  --report-agent codex \
  --confirm-live
```

传入 `--workspace <目录>` 时会验证项目只读模式；Codex、Claude Code、Grok、Pi 与 CodeBuddy 声明支持该模式，无法证明最低只读约束的适配器会在预检阶段被拒绝。Pi 禁用扩展、技能、模板和项目自动信任，只开放 `read,grep,find,ls`；CodeBuddy 使用 plan 权限并只开放 `Read,Glob,Grep`。预检会分别记录 Agent 身份、适配器、模型、可执行文件、模型就绪状态和项目只读能力，并缓存 10 分钟。

同一 Pi 可执行文件可注册多个独立模型身份，例如：

```toml
[[agents]]
id = "pi-deepseek"
name = "Pi · DeepSeek V4 Pro"
adapter = "pi"
model = "deepseek/deepseek-v4-pro"

[[agents]]
id = "pi-minimax"
name = "Pi · MiniMax-M3"
adapter = "pi"
model = "minimax/minimax-m3"
```

模型字符串使用 Pi 支持的 `provider/model` 形式。每条正式发言和最终方案都会分别保存 Agent ID、显示名称、适配器和模型。
