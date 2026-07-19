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

## 可选实机适配器冒烟

实机冒烟会调用已认证模型并可能产生费用，因此必须显式确认，且至少指定两个 Agent：

```bash
uv run python scripts/smoke_adapters.py \
  --agents codex,claude \
  --report-agent codex \
  --confirm-live
```

传入 `--workspace <目录>` 时会验证项目只读模式；Codex、Claude Code 与 Grok 声明支持该模式，无法证明最低只读约束的适配器会在预检阶段被拒绝。预检会分别记录可执行文件、模型就绪状态和项目只读能力，并缓存 10 分钟。
