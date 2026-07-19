---
name: deliberate-with-mad
description: Use the Multi Agent Decision (`mad`) CLI to run a structured, read-only, multi-Agent deliberation in fully automatic mode and return its auditable final report. Use when a user asks for 多 Agent 审议、多模型评审、独立反方意见、方案比较、架构或变更风险审议, or explicitly asks to use this project/MAD to deliberate a question or repository. Supports new text or project deliberations and automatic-mode recovery; never uses interactive checkpoints or DevUI.
---

# 使用 MAD 自动审议

通过本机 `mad` CLI 完成一次自动、结构化、只读的多 Agent 审议。把最终报告作为交付物，并保留审议档案路径以便核查。

## 自动模式硬约束

- 只使用 CLI 自动模式。绝不传入 `--interactive`，绝不启动 `mad serve`，绝不等待阶段检查点。
- 发起审议时始终传入 `--confirm-plan --format json`，避免任何终端确认提示。
- 恢复审议时使用 `mad resume ID --format json`，同样绝不传入 `--interactive`。
- 默认使用 `--convergence auto`。只有用户明确指定时才改为 `always` 或 `never`。
- 项目审议默认使用材料快照。除非用户明确要求读取原目录的实时或未跟踪内容，否则绝不传入 `--direct-workspace`。

## 执行流程

### 1. 明确审议问题与材料范围

把用户目标改写成一个自足、可审议的问题，保留用户给出的成功标准、约束和候选方案，不擅自扩大范围。

用户要求审议代码库、当前项目、改动或架构时，解析项目根目录的绝对路径并显式传入 `--workspace PATH`。`mad` 不会隐式把当前目录作为材料。纯概念问题可以不传工作目录。

审议只负责分析和形成报告。除非用户还明确要求实施，否则不要根据报告修改代码或配置。

### 2. 检查本机入口

先运行只读检查：

```bash
command -v mad
mad agents
```

若 `mad` 不存在，停止并说明需先使用 `$install-mad` 安装。不要隐式安装、升级或改写 shell 配置。

若已启用的参与者不足两个，停止并报告 `mad agents` 的状态。不要修改 `agents.toml`，不要替用户安装或认证外部 AI CLI。

### 3. 组装自动调用

项目审议的基准命令为：

```bash
mad deliberate "审议问题" \
  --workspace "/absolute/path/to/project" \
  --convergence auto \
  --confirm-plan \
  --format json
```

纯文本审议省略 `--workspace`。用户明确指定参与者、报告 Agent、组局 Agent、临时角色或并发数时，分别追加：

```text
--agents ID1,ID2
--report-agent ID
--organizer ID
--role ID=ROLE
--concurrency 1..6
```

不要自行启用 `--organizer`。未指定参与者时，让 `mad` 在预检成功的已启用 Agent 中使用默认方案。

### 4. 分离结果与诊断

不要把 stdout 与 stderr 合并。将 stdout 保存为结果 JSON，将 stderr 保存为进度和诊断日志；使用 `mktemp -d` 创建本次调用的临时目录，避免覆盖既有文件。例如：

```bash
mad_run_dir="$(mktemp -d)"
mad deliberate "审议问题" \
  --workspace "/absolute/path/to/project" \
  --convergence auto \
  --confirm-plan \
  --format json \
  >"$mad_run_dir/result.json" \
  2>"$mad_run_dir/progress.log"
mad_exit_status=$?
```

命令运行期间可读取 `progress.log` 汇报阶段进度，但不要把进度文本当作模型结论。成功后单独读取并解析 `result.json`；若 JSON 无效，即使退出码为零也按失败处理。

### 5. 按退出码处理

- `0`：解析结果 JSON；带警告完成仍属于成功，但必须展示关键警告。
- `1`：报告工作流、恢复或最终报告失败；展示精简诊断，并保留可恢复的审议 ID。
- `2`：报告参数、方案或配置错误；修正明确错误后才可重试，不要原样重跑。
- `3`：报告可用参与者不足；提示检查安装、认证和 `mad agents`。
- `130`：报告取消或终止；不要把部分输出当作结论。

不要因预检失败自动改用 `--direct-workspace`，不要猜测缺失的审议结论。只有自动模式创建或可按自动模式继续的档案才可执行：

```bash
mad resume DELIBERATION_ID --format json
```

### 6. 交付结果

向用户返回：

1. 最终报告或其忠实摘要；用户要求完整结果时返回完整报告。
2. 关键警告、仍未解决的争议和证据不足项。
3. 实际参与者、争议收敛是否触发以及完成状态。
4. 审议 ID 和审议档案绝对路径。

清楚区分报告中的事实、参与者判断和未决分歧。不要把结构化审议描述成投票结果或强制共识。
