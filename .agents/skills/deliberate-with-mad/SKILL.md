---
name: deliberate-with-mad
description: Run the Multi Agent Decision (`mad`) CLI in fully automatic, read-only mode and return its auditable final report. Use when the user asks for 多 Agent 审议、多模型评审、独立反方意见、方案比较、架构审查、变更或发布风险审议, or explicitly asks to use MAD/本项目审议 a question, repository, or current workspace. Supports structured or free-form deliberation, project-directory access, JSON result validation, and bounded automatic recovery; never uses guided checkpoints or `mad serve`.
---

# 使用 MAD 自动审议

使用本机 `mad` CLI 完成一次自动、只读的多 Agent 审议，并把最终报告、警告和审议档案位置交付给用户。

## 遵守自动模式边界

- 发起审议时始终同时传入 `--auto --auto-confirm-plan --format json`。
- 只使用 CLI；不要启动 `mad serve`，不要进入 guided 模式或等待检查点。
- 默认使用 `--mode structured`。仅当用户明确要求自由讨论、头脑风暴式交锋或开放式主持讨论时使用 `--mode free`。
- 不要使用不存在的旧参数，例如 `--confirm-plan`、`--interactive`、`--convergence`、`--agents`、`--report-agent`、`--role` 或 `--direct-workspace`。
- 审议只形成分析报告。除非用户另行要求实施，否则不要根据报告修改代码或配置。

## 1. 形成审议问题与材料范围

把目标改写成一个自足问题，保留成功标准、约束、候选方案和用户要求的反方视角；不要扩大范围。

用户要求审议仓库、当前项目、代码改动或架构时，解析项目根目录的规范化绝对路径并传入 `--workspace PATH`。`mad` 不会隐式读取当前目录。

`--workspace` 会授权组局器和最终方案中的参与 CLI 读取该完整目录。目录不会被复制或制作快照；适配器会以只读能力运行并在组局预检时验证。执行前向用户简短说明实际绝对路径以及“所选外部 CLI 可读取整个目录”，但用户已明确要求审议该目录时不要重复请求确认。

纯概念问题不要传 `--workspace`。

## 2. 检查本机入口与静态配置

先运行只读、无模型调用的检查：

```bash
command -v mad
mad --help
mad config validate
```

若 `mad` 不存在，停止并说明需使用 `$install-mad` 安装。不要隐式安装、升级或修改 shell 配置。

若静态配置无效，报告错误并停止。不要为了本次审议额外运行 `mad config check`；它会对全部配置组合发起真实模型调用并可能消耗额度，而 `mad deliberate` 会预检实际方案使用的组合。

方案至少包含两个临时 Agent 角色，但这些角色可以共享同一 CLI/preset。不要把共享来源描述成独立模型交叉验证。

## 3. 组装当前 CLI 调用

项目审议的基准命令为：

```bash
mad deliberate "审议问题" \
  --mode structured \
  --workspace "/absolute/path/to/project" \
  --auto \
  --auto-confirm-plan \
  --format json
```

纯文本审议省略 `--workspace`。用户明确选择自由讨论时改为 `--mode free`。

仅在用户明确指定时追加以下当前支持的覆盖项：

```text
--organizer CLI/PRESET
--max-participants N
--max-calls N
--max-discussion-windows N
--timeout-seconds N
--context-budget N
--global-concurrency N
```

参与者、角色、报告 Agent 和主持 Agent 由组局阶段生成，当前 CLI 没有对应的直接选择参数。把用户对此类内容的要求写入审议问题并在结果中核验；若最终方案未满足硬约束，明确报告，不要伪造参数或声称已满足。

## 4. 分离结果与诊断

使用 `mktemp -d` 创建本次运行目录。把 stdout 单独保存为结果 JSON，把 stderr 单独保存为进度与诊断；不要合并两个流，也不要覆盖既有文件。

```bash
mad_run_dir="$(mktemp -d)"
mad deliberate "审议问题" \
  --mode structured \
  --workspace "/absolute/path/to/project" \
  --auto \
  --auto-confirm-plan \
  --format json \
  >"$mad_run_dir/result.json" \
  2>"$mad_run_dir/progress.log"
mad_exit_status=$?
```

将长任务作为可轮询进程运行，定期读取新增的 `progress.log` 内容并向用户汇报阶段进展；不要把进度文本当作审议结论。不要因工具等待超时而启动第二个并发审议。

退出码为 `0` 时，确认 `result.json` 是单个有效 JSON 对象，并验证至少包含：

```text
deliberation_id, status="completed", mode, report, participants,
budget_usage, warnings, archive_path
```

即使退出码为 `0`，JSON 无效或缺少这些字段也按结果契约失败处理。

## 5. 按退出码恢复或停止

- `0`：解析并交付结果。
- `2`：用法或参数错误。只有明确知道正确参数时才修正并重试一次。
- `3`：配置错误。停止并报告配置问题。
- `4`：CLI/preset 预检失败。停止并报告对应组合、安装或认证问题。
- `5`：同一 `MAD_HOME` 已有活动审议。不要并发重跑；报告锁冲突。
- `20`：审议已暂停。若能从 stderr 取得审议 ID，且暂停不是用户主动要求，使用自动模式档案恢复一次。
- `21`：审议已取消且不可恢复。停止。
- `30`：执行或工作流失败。仅当诊断明确是瞬时故障且已取得审议 ID 时恢复一次；否则停止。

恢复命令只接受 ID 和输出格式，不能改变原模式、交互策略、方案或预算：

```bash
mad resume DELIBERATION_ID --format json
```

对恢复调用同样分离 stdout/stderr 并验证成功 JSON。最多自动恢复一次；不要循环重试，不要从档案猜测缺失结论。失败路径通常不产生结果 JSON，应从 stderr 提取精简诊断和已创建的档案路径。

## 6. 交付审议结果

返回：

1. `report` 的忠实内容；用户要求完整结果时原样返回完整报告。
2. `warnings`、报告中的未决争议、关键假设与证据不足项。
3. 实际 `mode`、参与者及其 CLI/preset、预算使用和完成状态。
4. `deliberation_id` 与 `archive_path` 的绝对路径。

清楚区分材料事实、参与者判断和未决分歧。不要把结构化审议描述成投票、强制共识或天然独立的多模型验证。
