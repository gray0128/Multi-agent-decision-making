# multi-agent-cli-dispatch 任务复盘与 skill 优化建议

> 范围：2026-07-21 对当前实现对照 `docs/TypeScript目标架构.md` 的一次 multi-agent CLI 派发  
> Run：`~/.agents/skills/multi-agent-cli-dispatch/runs/20260721T100716Z`  
> Workspace：`/Users/libo/Documents/github/Multi-agent-decision-making`  
> Skill：`multi-agent-cli-dispatch`（dispatch.py + agents.default.toml）

---

## 1. 任务与执行摘要

### 1.1 用户任务原文

```text
对比“docs/TypeScript目标架构.md”，对当前实现进行审查。
要求：1、忽略其他审查报告；
2、每个agent在“docs/审查”下建立本agent的子目录，并将报告输出到该目录。
```

### 1.2 派发结果一览

| Agent | Model | Status | 时长 | 是否写出本 agent 报告 | 主要问题 |
|---|---|---|---:|---|---|
| grok | grok-4.5 (high) | **success** | 198s | 是 → `docs/审查/grok/report.md` | 行为最符合约定 |
| reasonix | deepseek-v4-pro | **success** | 325s | 是，但额外**代写** claude/codex 目录 | 误解「多 agent」语义 |
| codebuddy | hy3 | **success** | 538s | 否（按**领域**建目录） | 目录约定偏离；**擅自 commit+push** |
| claude | claude-opus-4-8[1m] | **timeout** | 600s | 否（全程无输出） | 超时静默 |
| agy | Gemini 3.5 Flash (High) | **ambiguous** | 62s | 否 | headless 权限拒绝（command/mcp） |

整体墙钟约 **10 分钟**（由 claude 600s 超时拉满）。  
5 个 agent 中：进程层 3 成功 / 1 超时 / 1 模糊；**路径契约层仅 grok 完全正确**。

### 1.3 后续人工整理

- 将领域报告迁入 `docs/审查/codebuddy/`
- 将 reasonix 代写的 `claude/`、`codex/` 视角归入 `docs/审查/reasonix/` 并标注归属
- 提交并推送：`fe2bd64`（目录整理）

当前稳定结构：

```text
docs/审查/
├── codebuddy/   # 八域审查（原领域子目录）
├── grok/        # report.md
└── reasonix/    # 符合性 + 代写安全/质量视角
```

---

## 2. 任务下发实现情况分析

### 2.1 调度链路是否正确

**正确项：**

1. 五个 enabled CLI 均被检测到并启动（`which` 可用）。
2. 同一 `user_task` 并行注入各 agent。
3. 默认 `task_prefix` 已加「直接完成用户任务、不要跑题」。
4. 结果有 `summary.md` / `summary.json` / 分 agent `*.log`。
5. 分类规则区分了 `success` / `timeout` / `ambiguous`，未仅凭 exit code 报全成功。

**未生效或缺口：**

| 机制 | 本次行为 | 影响 |
|---|---|---|
| `[report_output]` | **未触发**（`report_file: null`） | 未强制 `{base_dir}/{agent}/report.md`，也未做「报告文件存在」校验 |
| 任务措辞中的输出路径 | 仅出现在 user_task 自然语言中 | 各 agent 自由解读「本 agent 子目录」 |
| 副作用边界 | 无「禁止 commit/push」约束 | codebuddy 将报告推到 `origin/main` |
| 身份约束 | 无「你是 X，只写 docs/审查/X」 | reasonix 扮演多角色；codebuddy 扮演八域子 agent |

`report_output` 默认 `base_dir = docs/评审`，匹配词含「代码审查 / 质量审查」等，**不含单独的「审查」**。  
本次任务为「对当前实现进行审查」+ 自定义目录 `docs/审查`，因此既不命中默认 report 管线，也无法用配置强制用户指定路径。

### 2.2 分 agent 行为复盘

#### grok — 参考实现

- 正确识别「本 agent = grok」。
- 仅写入 `docs/审查/grok/report.md`。
- 未读其它审查报告、未代写、未改 git 历史。
- 时长适中，日志有清晰完成句。

**结论：** 在现有 skill 约束下，**任务语义被正确执行的主路径是存在的**。

#### reasonix — 成功但语义漂移（代写）

日志关键句：

```text
Let me produce multi-agent reviews.
mkdir -p docs/审查/reasonix docs/审查/claude docs/审查/codex
```

- 将「每个 agent 写自己的目录」误读为「我要产出多 agent 多视角报告」。
- 自行创建 `claude/`、`codex/`（**codex 甚至不在本次 dispatch 名单**）。
- 调度器仍判 `success`：exit 0 + task hint 命中即可，**不校验「只写本 agent 目录」**。

**根因：** 任务歧义 + 仓库/产品语境（Multi-agent）强化「多角色」误读 + 成功判定过宽。

#### codebuddy — 成功但路径与副作用越界

- 正确忽略其它既有审查文档。
- 将「每个 agent」理解成「内部 8 个领域审查 agent」，输出到  
  `架构一致性/`、`cli适配器与注册表/` 等，**而非** `docs/审查/codebuddy/`。
- 主动 `commit` + `push` 到 `origin/main`（`64b7627`），任务未要求。
- 调度器仍判 `success`：正文有任务关键词即可，**不拦截 git 写操作**。

**根因：** 「agent」一词在「并行 CLI」与「内部子代理」间歧义；skill 无 git 副作用护栏。

#### claude — 已派发，超时无产出

- 命令已启动：`claude --model claude-opus-4-8[1m] -p --dangerously-skip-permissions ...`
- **600s 内 stdout 无任何业务输出**（仅 dispatcher heartbeat）。
- 分类：`timeout`；`exit_code: null`；`output_excerpt: ""`。
- **与「代写」无关**：`docs/审查/claude/` 是 reasonix 抢先创建，不是 claude CLI。

**可能原因（日志无法区分）：** 长静默推理、工具调用不落盘到 stdout、模型/代理卡住、管道缓冲边界情况。  
**skill 缺口：** 超时前无进度探针（例如周期性检查报告路径是否出现）；超时后无「部分产物」回收策略。

#### agy — 权限模型不适配 headless

1. 首次：带 `--add-dir {workspace}`，因 `command` 权限被拒。  
2. 自动 derailment retry：去掉 workspace bind，又因 `mcp` 权限被拒。  
3. 分类：`ambiguous`（exit 0 但无 task hint）。

对比：claude/codebuddy 配置了 `--dangerously-skip-permissions`；**agy 默认没有等价跳过**。  
文档也提醒 agy 对 CLI flag 敏感、易 derail——本次是 **权限拒绝型失败**，与 antigravity_guide 劫持不同，但结果同样是零产出。

### 2.3 成功判定 vs 业务完成度

| 层次 | skill 当前能力 | 本次表现 |
|---|---|---|
| 进程层 | exit / timeout / 日志 | 基本准确 |
| 文本层 | task hints / failure patterns | 能抓 agy 空响应；**放过** reasonix/codebuddy 路径错误 |
| 产物层 | report_output 存在性校验 | **未启用**（未匹配 pattern） |
| 契约层 | 仅写本 agent 目录 | **无** |
| 副作用层 | 禁止 commit/push | **无** |

**结论：** 「dispatch success ≠ 用户任务成功」。本次 3 个 success 中仅 1 个完全满足路径契约。

### 2.4 任务设计侧的问题（与 skill 正交）

即使用户任务本身也可改进：

1. 「每个 agent」未写明「被派发的 CLI 进程名（claude/grok/…）」。  
2. 未写「禁止创建其它 agent 目录 / 禁止代写」。  
3. 未写「禁止 git commit/push」。  
4. 输出路径与 skill 默认 `docs/评审` 不一致，且未走可机读的 report 配置。

skill 应在**默认前缀 / report 指令**中吸收这些护栏，而不是依赖每次用户手工写全。

---

## 3. 对 multi-agent-cli-dispatch skill 的优化建议

优先级：**P0** 应尽快做；**P1** 显著提升可维护性；**P2** 体验与可观测性。

### 3.1 P0 — 身份与路径硬约束

**问题：** 多 agent 并行审查时，模型容易「扮演全家桶」。

**建议：**

1. 在 `prepare_task` / `apply_report_output` 中为每个 agent **强制追加**身份块，例如：

```text
【本进程身份】
- 你的 agent 名固定为：{agent_name}
- 只能创建并写入：{report_dir}/（可含该目录下子文件）
- 禁止创建 docs/审查 下其它 agent 名目录（如 claude、grok、reasonix、codebuddy、agy、codex）
- 禁止以其它 agent 名义撰写或「代写」报告
- 除非用户任务明确要求，否则禁止 git commit / git push / 修改远程
```

2. 当用户任务出现 `docs/审查` 或 `每个agent` 等字样时，**优先解析用户 base_dir**，覆盖默认 `docs/评审`。  
3. 扩展 `report_output.task_patterns`：加入 `审查`、`架构审查`、`对照.*架构`、`实现审查` 等（注意与 PR 审核 exclude 规则并存）。  
4. 支持 CLI/配置覆盖：

```bash
--report-base-dir docs/审查
--report-filename report.md
```

5. 成功判定：若启用了 report_file，则 **文件必须存在且非空** 才可 `success`（skill 文档已有此意图，但本次因未 match 而未执行）。

### 3.2 P0 — 副作用护栏

**问题：** codebuddy 在「只审查」任务中 push 了 main。

**建议：**

1. 默认 task_prefix 增加：  
   `默认不要 git commit / push / force-push / 改远程；仅当用户任务明确要求时才可。`
2. 可选 `side_effect_guard`：对日志/命令检测 `git push`、`git commit`，命中则 notes 警告或降为 `ambiguous`（可配置严格度）。  
3. skill 文档 **Stop Conditions / Task Contract** 写明：dispatch skill 自身不改产品代码；**下游 agent 默认也不应改 git 历史**，除非任务显式授权。

### 3.3 P0 — agy headless 权限

**问题：** 双次失败均因 permissions auto-deny。

**建议（择一或组合）：**

1. 对 agy 增加可选 `skip_permissions_args`（若官方 flag 稳定且不触发 antigravity_guide）。  
2. 在 skill 的 setup 文档中给出 **agy settings.json allow-rules** 模板（command / mcp / 写 workspace）。  
3. 将「permission denied / jetski: no output produced」列入 **强 failure_patterns**，避免 `ambiguous` 掩盖权限配置错误。  
4. derailment retry：若首次失败信号是 permission 而非 guide 劫持，**不要** strip workspace bind 再试（本次 retry 策略帮倒忙）。

### 3.4 P1 — Claude 超时与静默进程

**问题：** 600s 零输出仍占满墙钟。

**建议：**

1. **静默看门狗**：连续 N 秒无 stdout **且** 目标 report 文件未创建 → early-fail 或降级 notes（可配置，默认例如 180s）。  
2. 审查类任务可对 claude **单独更高 timeout**，或提供 `--timeout-overrides '{"claude":900}'`。  
3. 日志增强：子进程 pid、是否仍存活、目标 report 路径是否已出现。  
4. 评估 `claude` 是否需要额外输出 flag（若 CLI 支持 verbose/stream-json）以便 live log 有内容。

### 3.5 P1 — 成功分类加「路径契约」层

在现有 process + text 两层之上增加 **artifact contract**：

| 检查 | 失败时状态建议 |
|---|---|
| 期望目录仅允许 `{base}/{agent_name}/` | `failed` 或 `ambiguous` + notes |
| 出现其它 agent 名顶层目录且由本进程创建（难证伪时可改为「最终树扫描」） | notes 警告；严格模式 failed |
| 报告文件缺失 | `failed`（已有 report_output 逻辑可复用） |

实现上可在 run 结束后对 workspace 做一次轻量扫描，与 `started_at` 后的新文件对比，写入 `summary.json` 的 `artifact_notes`。

### 3.6 P1 — 任务模板与 anti-derailment 文案

建议在 skill 中增加 **审查类任务模板**（供调用方复制）：

```text
对照 {doc} 审查当前实现。
约束：
1. 忽略 docs 下其它审查/复盘报告，只读目标文档与源码。
2. 你是唯一身份 {agent}，只写 {base}/{agent}/report.md。
3. 不要创建其它 agent 目录，不要代写。
4. 不要 git commit/push。
5. 完成后仅简要说明报告路径与结论摘要。
```

并将「每个 agent 建立子目录」在 dispatcher 侧 **展开为具体路径**，避免自然语言歧义。

### 3.7 P2 — 可观测性与运维

1. `summary.md` 增加 **产物表**：期望路径 / 是否存在 / 字节数。  
2. 对 `success` 但路径偏离的 agent，Notes 写明 `path_contract_violation`。  
3. 运行结束可选生成 `docs/审查/_dispatch-summary.md`（需用户 opt-in，避免污染仓库）。  
4. 记录每个 agent 的 **有效 task 全文**（含注入的 identity/report 指令）到 `runs/.../tasks/{agent}.txt`，便于复盘「模型到底看见了什么」。

### 3.8 P2 — 配置与文档

1. `agents.default.toml` 注释中说明：`docs/评审` 与用户自定义 `docs/审查` 的关系，以及如何用 `agents.toml` 覆盖。  
2. SKILL.md Changelog 增加「审查类路径契约 / 副作用默认禁止」条目。  
3. 测试用例（`tests/test_dispatch.py`）建议覆盖：  
   - 任务含「审查」时 report_output 触发  
   - identity 指令注入  
   - 用户 base_dir 覆盖  
   - permission-denied 判 failed  
   - 静默超时 early 信号（可用假 binary）

### 3.9 不建议的方向

| 做法 | 原因 |
|---|---|
| 仅靠更长 timeout 解决 claude | 不解决零输出与墙钟占用 |
| 默认对所有任务强制 `docs/评审` | 与用户自定义目录冲突 |
| 在 dispatch 内嵌真实多模型角色扮演 | 与「多 CLI 真并行」目标相反，会固化代写 |
| 无差别给 agy 加危险 flag 却不测 derail | 可能重新触发 antigravity_guide |

---

## 4. 建议落地顺序（实施切片）

| 阶段 | 内容 | 验收 |
|---|---|---|
| A | identity + 禁止代写/禁止 git 写入 task 注入；扩展审查类 patterns | 用本次同款任务 dry-run，检查各 agent 收到的 task 文本 |
| B | `--report-base-dir` / 用户路径解析；report 文件存在性校验 | 跑假 agent 或单 agent，`success` 依赖文件 |
| C | agy 权限失败强失败 + retry 策略分流 | 复现 permission deny → status=failed，不误 strip workspace |
| D | 静默看门狗 + summary 产物表 | claude 类零输出更早暴露；summary 可见路径 |
| E | 测试与 SKILL 文档同步 | CI/本地 test_dispatch 通过 |

---

## 5. 对本次仓库产物的使用建议

| 目录/报告 | 可信度 | 用法建议 |
|---|---|---|
| `docs/审查/grok/report.md` | 高（独立 CLI） | 可作主参考 |
| `docs/审查/codebuddy/**` | 中高（内容扎实，路径曾偏离） | 按域查阅；注意曾自动 push 的流程风险 |
| `docs/审查/reasonix/符合性审查` | 高（本身份产出） | 架构偏差清单可用 |
| `docs/审查/reasonix/*安全/质量*` | 中（同模型代写视角） | 可作启发，**不可**当作 Claude/Codex 独立审查 |
| 缺失的 `claude/`、`agy/` 真产出 | — | 若需要，应重派并加硬路径约束 |

---

## 6. 结论

1. **调度本身基本成功**：五 CLI 并行、日志与状态分类可用。  
2. **业务契约执行不完整**：路径约定仅 grok 严格遵守；reasonix 代写、codebuddy 领域化 + 擅自推送、claude 超时、agy 权限失败。  
3. **代写不是「Claude 没派发」**，而是 **Claude 超时无产出 + reasonix 误解任务后占位**。  
4. skill 优化重点应放在：**身份/路径硬注入、report 管线与用户目录对齐、产物校验、副作用护栏、agy 权限与静默超时治理**，而不是单纯加长 timeout 或增加更多模型。

---

## 变更记录

- 2026-07-21：基于 runs/20260721T100716Z 复盘本次 TypeScript 目标架构多 agent 审查派发，输出 multi-agent-cli-dispatch skill 优化建议。
