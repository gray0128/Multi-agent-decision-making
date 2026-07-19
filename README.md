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
