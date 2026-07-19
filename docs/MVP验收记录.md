# MVP 验收记录

## 验收范围

本记录收口 [MVP 后续工作追踪 #8](https://github.com/gray0128/Multi-agent-decision-making/issues/8)。验收基线为安装与集成文档合并后的 `main`，覆盖子 Issue #1 至 #7、MVP 设计中的 12 条验收标准，以及一次真实多 CLI 项目审议。

## 子 Issue 与合并记录

| 优先级 | Issue | 合并 PR | 结果 |
|---|---|---|---|
| 基线 | 可运行切片 | #9 | 已合并 |
| P0 | #2 真实 CLI 适配器与预检 | #10 | 已关闭 |
| P0 | #1 DevUI 检查点与暂停恢复 | #11 | 已关闭 |
| P1 | #3 持久化恢复与整阶段重跑 | #12 | 已关闭 |
| P1 | #4 组局 Agent 与方案确认 | #13 | 已关闭 |
| P1 | #5 上下文预算与统一摘要 | #14 | 已关闭 |
| P1 | #6 Pi、CodeBuddy 与多模型 | #15 | 已关闭 |
| P2 | #7 安装与 Coding Agent 文档 | #16 | 已关闭 |

## 自动化验收

在仓库虚拟环境执行：

```bash
.venv/bin/python -m pytest -q
.venv/bin/python -m py_compile src/mad/*.py scripts/*.py
git diff --check
```

结果：69 个测试全部通过，Python 编译和差异格式检查通过。此前还在隔离的空 tool 目录验证了 `uv tool install .`，并在隔离 `MAD_HOME` 中成功执行 `mad init`、`mad agents` 与 `mad --help`。

测试覆盖的 MVP 验收能力包括：多模型 Agent 身份、纯文本和项目入口、机器可读输出、阶段并发与屏障、四个检查点、失败降级、取消恢复、报告草拟/审阅/定稿、默认材料快照、临时文件保护、争议自动触发和单轮收敛。

## 真实多 CLI 端到端验收

为避免修改用户注册表，本次使用隔离 `MAD_HOME`，注册本机已认证的以下两个不同 CLI 运行时：

- Pi，模型 `deepseek/deepseek-v4-pro`；
- Codex，使用 CLI 当前默认模型。

调用形态：

```bash
mad deliberate "核验当前仓库 MVP：给出三条可交付证据、一项最高风险和明确回滚条件。" \
  --workspace . \
  --agents pi-deepseek,codex \
  --report-agent codex \
  --convergence always \
  --confirm-plan \
  --format json \
  --concurrency 2
```

可核查结果：

- 退出码为 `0`，状态为“完成”，无降级警告；
- 使用默认材料快照，没有启用直接工作目录；
- Pi 与 Codex 均通过真实预检并参与独立陈述、质疑、修订和争议收敛；
- `always` 策略实际触发，整理出 3 项关键争议，收敛状态为“已完成”；
- Codex 完成报告草拟，Pi 完成独立报告审阅，Codex 完成唯一一次最终修订；
- 标准输出返回单个 JSON 结果，正式档案状态为“完成”。

## 实机验收发现与修正

1. CodeBuddy 2.119.2 的 JSON 输出是顶层数组。适配器现会提取最终 `result`；缺少最终结果时只接受 assistant 文本，不会把 user/system 内部上下文当作公开发言。长项目分析仍可能由 CodeBuddy 自身返回空公开结果，MAD 会失败关闭并保存为可恢复状态。
2. Git 材料快照此前可能跟随已跟踪符号链接读取工作目录外文件。现已拒绝所有符号链接，并有路径逃逸回归测试。
3. 非 Git 材料快照此前可能复制隐藏目录中的普通文件。现按设计排除整个隐藏目录树。
4. Git 中显式跟踪的 `.env.local` 等变体此前可能进入快照。现统一排除所有 `.env*` 路径段。

## 结论

Issue #1 至 #7 均已关闭，自动化验收通过，且已完成一次真实 Pi + Codex、默认项目快照、强制争议收敛的完整审议。Issue #8 的完成定义已满足。

## 变更记录

- 2026-07-19 21:35 CST：新增 MVP 收口验收记录，记录自动化、真实多 CLI 审议、实机发现与安全修正。
