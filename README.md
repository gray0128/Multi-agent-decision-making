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
