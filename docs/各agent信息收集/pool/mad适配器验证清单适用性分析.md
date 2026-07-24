# Pool CLI — mad 适配器验证清单适用性分析

> 状态：实测报告（本机）。依据 [docs/新增CLI适配器验证清单.md](../../新增CLI适配器验证清单.md) 对 Poolside `pool` CLI 做接入前验证。  
> 验证版本：`1.0.14`（`215a0738eb`，20260721）  
> 可执行文件：`/Users/libo/.local/bin/pool`  
> 验证日期：2026-07-24  
> 验证环境：macOS，已 `pool login`（standalone / `https://inference.poolside.ai`），本机 Docker/OrbStack **未运行**  
> 对照实现：`src/adapters/*`  
> 旧版评估（偏静态、未按新清单分层）：[适用性分析.md](适用性分析.md)

---

## 1. 结论摘要

| 维度 | 判定 | 说明 |
|---|---|---|
| **A. 一般审议适配器** | **有条件通过 / 暂缓接入** | 非交互、stdin、READY、JSON 事件流、超时终止均可用；但 **`pool exec` 无法按 preset 指定 model**，与 mad「调用预设含 model」契约冲突 |
| **B. 项目审议适配器** | **本机未通过；理论上待复测** | `--sandbox disabled` 下 canary **写入成功**；`--sandbox required` 依赖 workspace `sandbox:` 配置 + 容器运行时，本机因 Docker 不可用失败 |
| **C. 不适合接入** | 否（未达硬否决的「完全不能非交互」） | 不适合「开箱即用」接入；需代码与运行环境补齐后才可评估上线 |
| **publicText / publicError** | **必须扩展后方可接入** | NLJSON `type: "assistantMessage"` 当前抽不出最终文本；且 `toolCallResult.result` 会被误当成 `result` 最终答案 |
| **作为开发工具** | **可用** | `pool exec` + 登录凭证适合本机自动化；与 mad 适配器门槛分离 |

**推荐最终勾选（按清单第 2 章）：**

```text
[x] 可接入但需扩展 publicText / publicError
[x] 可接入但项目模式声明 unsupported   （在 canary 未在可信沙箱复测通过前）
[ ] 适合一般审议（维度 A）              （阻塞：exec 无 --model）
[ ] 适合项目审议（维度 A + B）
[ ] 不适合作为 mad 适配器               （未选：基础调用能力足够，属「契约缺口」而非不可用）
```

一句话：**Pool 适合作为「一次性非交互 Agent CLI」候选，但按 mad 当前契约尚不能直接上线；优先阻塞项是 exec 级模型固定能力与输出解析，项目只读依赖可配置沙箱 + Docker 且本机未实证。**

---

## 2. 参数映射（真实 flag，非示例名）

来源：`pool --help`、`pool exec --help`、[官方 automated-mode](https://docs.poolside.ai/cli/automated-mode.md)、[CLI reference](https://docs.poolside.ai/cli/cli-reference.md)（文档写 v1.0.13，本机 v1.0.14，flag 一致）。

### 2.1. 探测与安装

| 用途 | 真实命令 / 路径 |
|---|---|
| probe | `pool --version` / `pool -v` → 打印 `1.0.14`，退出码 0，约 20ms |
| 无效 | `pool version` → unknown command |
| help | `pool help` / `pool --help` |
| 配置路径 | `pool config` → log / trajectory / `~/.config/poolside` / credentials |

### 2.2. 非交互调用（`pool exec`）

| 用途 | 真实 flag | 实测 |
|---|---|---|
| 非交互入口 | `pool exec` | 成功 |
| prompt（argv） | `-p` / `--prompt` | 成功 |
| prompt（stdin） | `-p -` 或 `pool exec < file` | 成功 |
| prompt（文件） | `-f` / `--prompt-file` | 成功 |
| 工作目录 | `-d` / `--directory` | 成功（读到 marker 文件） |
| 输出 | `-o markdown` \| `-o json`（NLJSON） | 成功 |
| 自动审批 | `--unsafe-auto-allow` | READY 路径需要，否则非交互易卡住 |
| 沙箱覆盖 | `--sandbox required` \| `disabled` | 见第 7 章 |
| 续跑 | `--continue` / `--continue=<run-id>` | **mad 不得使用**（破坏一次性隔离） |
| 模型 | **无** | `pool exec` **没有** `--model` / `-m` |
| Tenant Agent | `-a` / `--agent-name` | standalone 模式报：not supported |
| API URL | `--api-url` | 无效 URL 返回 JSON `{"error":"no auth token provided"}` 等 |

说明：顶层交互式 `pool` 才有 `-m/--model`、`-C/--directory`、`-r/--resume` 等；**自动化路径是 `pool exec`，模型 flag 不共享。**

### 2.3. 建议 mad 调用骨架（若未来接入）

```bash
# 一般审议（当前能力上限：默认登录模型，无法 per-preset 覆盖）
pool exec \
  --sandbox disabled \
  --unsafe-auto-allow \
  -o json \
  -d <cwd> \
  -p -   # stdin: prompt
```

项目模式仅在确认 workspace 已配置 `sandbox.filesystem.workspaces.access: read-only` 且容器运行时可用后，才应改为 `--sandbox required`。

---

## 3. 清单逐项实测（维度 A / B）

图例：`PASS` 通过 · `FAIL` 未通过 · `PARTIAL` 部分 · `N/A` 本环境不可测 · `RISK` 有风险通过

### 3.1. 安装与探测

| 序号 | 项 | 结果 | 证据 |
|---|---|---|---|
| 3.1 | 可执行文件可访问 | **PASS** | `command -v pool` → `/Users/libo/.local/bin/pool` |
| 3.2 | 探测命令 | **PASS** | `pool --version` → `1.0.14`，exit 0，不消耗模型、不要求交互登录即可读出版本 |

### 3.2. 非交互调用

| 序号 | 项 | 结果 | 证据 |
|---|---|---|---|
| 4.1 | 非交互 + READY | **PASS** | `pool exec --sandbox disabled --unsafe-auto-allow -o markdown -p "只回复 READY…"` → stdout 含 `READY`，exit 0 |
| 4.2 | 提示传入 | **PASS**（推荐 stdin 可用） | `-p` / `-p -` / `-f` 均成功；stdin JSON 路径同样得到 `assistantMessage: READY` |
| 4.3 | 可指定模型 | **FAIL** | `pool exec --model …` → `unknown flag: --model`；`-m` 被拒并提示与 obsolete `model-name` 相关错误。官方 CLI reference：`--model` 仅列在顶层 `pool`，**未列在 `pool exec`** |
| 4.4 | cwd 生效 | **PASS** | `-d "$TEST_DIR"` 后 `read` 工具路径指向该临时目录内 `marker.txt`，内容 `hello-from-test` |

**对维度 A 的影响：** 清单将「可指定模型」列为硬门槛之一（对应 `InvocationPreset.model`）。在只能使用登录默认模型、且无法在适配器内写死 per-preset `--model` 的情况下，**不能满足 mad 多预设/多模型配置模型**。除非产品接受「Pool 仅单模型 CLI、preset.model 只能等于默认且运行时无法校验」，否则维度 A 不能标为完全通过。

### 3.3. 输出与解析

#### 3.3.1. 真实 JSON 样本（READY）

```json
{"message":"READY","type":"assistantMessage"}
{"args":{"success":true},"name":"exit","type":"toolCall"}
{"result":"","type":"toolCallResult"}
```

带工具时还会出现：`reasoning`、`thought`、`toolCall`、`toolCallResult`（`result` 为工具输出字符串）。

#### 3.3.2. 与 `publicText` / `publicError` 对照

| 项 | 结果 | 证据 |
|---|---|---|
| 5.1 可提取最终公开文本 | **PARTIAL** | markdown 路径肉眼可见 `READY`，但夹杂 `⏺ exit(success:true)`。JSON 路径用**当前** `publicText`：`publicText(raw) === ""`（READY 样例无非空 `result` 时） |
| 5.1 误解析风险 | **FAIL（严重）** | canary 跑次中，`toolCallResult.result` 非空时，当前 `publicText` 把 **工具输出** 当作 `item.result` 最终答案，返回读文件/写文件结果串，**忽略** `assistantMessage` |
| 5.2 JSON/JSONL 兼容 | **需扩展** | 事件类型为 `assistantMessage`，不是 `assistant` / `agent_message` / `message` |
| 5.3 业务错误 | **PARTIAL** | `--sandbox required` 且无配置时：exit **1**，stdout `{"error":"sandbox is required…"}` → 现有 `publicError` **可提取** `error` 字符串。认证类：`--api-url` 无效时 stdout `{"error":"no auth token provided"}`，exit 1 |
| 5.4 Schema | **PARTIAL** | 无 `--json-schema`；仅能靠 prompt 约束。模型可输出证据 JSON（见 canary） |

**接入前置代码工作（最小）：**

1. `publicText`：识别 `type === "assistantMessage"`，取 `message` 字符串；  
2. **不要**把 Pool 的 `toolCallResult.result` 当成最终 `result`（可按 `type` 过滤，或仅在 `type` 缺失/为 result 类事件时采纳 `result`）；  
3. `publicError`：已能处理顶层 `error` 字符串；可再观察是否有其它错误事件类型；  
4. markdown 路径不推荐作为 `expectedStructured` 主路径。

### 3.4. 安全边界（结果导向）

| 序号 | 目标 | 结果 | 证据 / 等价手段 |
|---|---|---|---|
| 6.1 会话隔离 | **PARTIAL** | 默认不传 `--continue` 时每次 exec 为独立 run；但 **每次成功 run 仍落盘** `~/Library/Application Support/poolside/sessions/session-*.json` 与 `trajectories/trajectory-*.ndjson`。session 文件含 `run_id/session_id/agent_id/timestamp`。隔离语义是「不自动续聊」，不是「零落盘」 |
| 6.2 工具/外部能力收敛 | **PARTIAL / RISK** | **有**：`--sandbox required` + workspace `sandbox.filesystem.workspaces.access: read-only`（官方 skill / 文档）；`--unsafe-auto-allow` 解决非交互审批。**无**：工具白名单、禁用 Web、禁用 MCP、禁用子 Agent 的 exec 级 flag。MCP 由 `settings.yaml` / `.poolside` 管理，适配器无法在单次 argv 清空。**日志显示** exec 会发现本机大量 skills（含仓库内 `deliberate-with-mad`、`install-mad` 等） |
| 6.3 递归 mad | **RISK** | 进程可用 `MAD_PARTICIPANT=1` 门闩；但 Pool 会加载 skills，存在被 skill 引导调用 `mad` 的路径。适配器必须：环境变量守卫 + prompt 禁止 + 评估关闭 skills/限制 instruction 的配置手段（**当前 exec 未见 `--no-skills`**） |

### 3.5. 项目只读（维度 B）

| 序号 | 项 | 结果 | 证据 |
|---|---|---|---|
| 7.1 能力声明建议 | **暂 `unsupported`，或预留 `runtime-canary`** | 在 Docker + read-only sandbox 未复测通过前，不得对用户开启项目模式 |
| 7.2 canary（sandbox disabled） | **FAIL** | 模型 `read` 正确读出 nonce，随后 `write` 创建 `must-not-exist.txt`，证据 JSON 为 `write_result: "succeeded"`，文件确实存在 |
| 7.2 canary（sandbox required + 本地 settings） | **N/A（基础设施失败）** | 在临时目录写入 `.poolside/settings.local.yaml`（`access: read-only`）并 `--sandbox required` → exit 1：`failed to pull image ubuntu:22.04: Cannot connect to the Docker daemon … orbstack …`。**未测到**「沙箱内写被拒」的行为正确性 |
| 7.2 稳定性 | **未测** | 依赖沙箱通路先打通 |

**结论：** 无沙箱时 Pool **明确不具备**项目只读；有沙箱时官方模型支持 filesystem `read-only`，但 **必须以 canary 在目标机器复测**，不能仅凭 YAML 声明。

### 3.6. 退出码、超时、输出上限

| 序号 | 项 | 结果 | 证据 |
|---|---|---|---|
| 8.1 退出码 | **PASS（文档清晰）** | 官方：`0` 成功；`4` 任务失败；其它意外错误。实测：成功 READY → 0；flag/沙箱错误 → 1；JSON 错误体可出现在 stdout |
| 8.2 脱敏 | **PARTIAL** | 本机错误输出未见完整 API key；`pool mcp list` 文档称敏感头脱敏。仍须走 `redactAdapterDiagnostic` |
| 8.3 外部 SIGTERM | **PASS** | 长任务 `pool exec … "请睡眠 60 秒…"` 启动约 4s 后 `kill -TERM`，`wait` 退出码 1，stdout/stderr 为空 |
| 8.4 输出 &lt; 8MB | **PASS（stdout）** | READY/工具短任务 stdout 远小于 8MB。注意：trajectory 落盘可达数十 KB～数 MB，**不计入** mad `runProcess` 8MB，但属本机隐私/磁盘面 |

---

## 4. 与 mad `CliAdapter` 契约对照

| 成员 / 约束 | Pool 现状 | 接入含义 |
|---|---|---|
| `probe` | `pool --version` | 可直接实现 |
| `check`（READY） | 需 `--unsafe-auto-allow`，建议 `-o json` + 扩展后的 `publicText` | 可实现 |
| `invoke` | `pool exec` + stdin/`-p -` | 可实现 |
| `projectReadOnlyCapability` | 当前应 **`unsupported`** | 与 Reasonix/AGY 同类，直到 canary 绿 |
| `verifyProjectReadOnly` | 无沙箱必失败；有沙箱待测 | 未通过前勿标 runtime-canary |
| preset.`model` | **exec 无法注入** | **阻塞** 类型化多模型预设 |
| 禁止 `extra_args` | 安全参数须写死在适配器 | 可做到；但 skills/MCP 来自用户全局配置，**argv 无法完全冻结** |
| `MAD_PARTICIPANT` | 进程级有效 | 必须保留；不能替代 skill 面风险 |
| `jsonSchema` / canary | 仅 prompt | 可仿 Grok `--rules` 式注入 |

配置侧若强行引入 `adapter = "pool"`：

- `ADAPTER_IDS` / `createAdapter` / schema 均需新增；  
- `presets[].model` 若无法下发，要么拒绝多 model，要么仅作展示标签（**与目标架构「可信调用预设」冲突**，不推荐）。

---

## 5. 维度判定明细

### 5.1. 维度 A 核对表（一般审议）

| 序号 | 要求 | 结果 | 证据摘要 |
|---|---|---|---|
| 3.1 | 可执行文件 | PASS | PATH 可访问 |
| 3.2 | 探测 | PASS | `--version` |
| 4.1 | 非交互 READY | PASS | markdown/json |
| 4.2 | 提示传入 | PASS | stdin/argv/file |
| 4.3 | 指定模型 | **FAIL** | exec 无 model flag |
| 4.4 | cwd | PASS | `-d` |
| 5.1 | 公开文本 | PARTIAL | 需改 publicText；现状会误解析工具 result |
| 5.3 | 业务错误 | PARTIAL | `{"error"}` + 非 0 退出码 |
| 6.1 | 会话隔离 | PARTIAL | 不续聊但落盘 trajectory |
| 6.2 | 工具面收敛 | PARTIAL | 依赖沙箱/配置，无工具白名单 |
| 6.3 | 抑止递归 mad | RISK | skills 含 deliberate-with-mad |
| 8.1–8.4 | 进程契约 | PASS | 见上 |

**维度 A：未全部通过**（硬缺口 4.3；解析 5.1 在改代码前也不可用）。

### 5.2. 维度 B 核对表（项目审议）

| 序号 | 要求 | 结果 |
|---|---|---|
| 7.1 声明一致 | 当前应 unsupported |
| 7.2 读 nonce | disabled 下可读；required 未跑通 |
| 7.2 写阻断 | disabled 下 **失败（写成功）**；required 未实证 |
| 稳定性 | 未测 |

**维度 B：不通过。**

### 5.3. 实现成本项

| 项 | 结果 |
|---|---|
| 原生 JSONL | 有，但需扩展解析器 |
| 原生 schema | 无 |
| stdin prompt | 有（推荐） |

---

## 6. 与旧版「适用性分析」差异

| 点 | 旧文 | 本次实测 |
|---|---|---|
| 模型 | 写「`-m` 支持」 | **仅交互式 `pool`；`pool exec` 不支持** |
| 目录 flag | 写 `-d` | 确认 `pool exec -d` 正确；顶层交互是 `-C` |
| 安全 flag 清单 | 以「缺 Grok 同款 flag」为主 | 改为结果导向：沙箱/审批/续跑/skills/MCP |
| 只读 | 「可能满足，需测」 | **disabled 下明确不满足**；required 依赖 Docker，本机失败 |
| publicText | 「需识别 assistantMessage」 | 确认；并发现 **`result` 字段误吸收 tool 输出** 的更严重问题 |
| 判定 | 约 6/10 可行 | **暂缓接入**；路径清晰但有硬阻塞 |

---

## 7. 风险清单（接入前必须处理）

1. **模型不可配置（P0）**  
   - mad 每个 preset 需要可信 model。  
   - 选项：上游为 `pool exec` 增加 `--model`；或 Pool 仅单预设且文档声明「忽略/校验等于默认」——后者削弱架构一致性。

2. **输出解析（P0）**  
   - 必须扩展 `publicText`，并避免 `toolCallResult.result` 污染最终文本。

3. **项目只读（P0 for workspace 模式）**  
   - 默认禁用项目模式；  
   - 复测条件：Docker（或官方支持的 sandbox runtime）+ workspace `sandbox.filesystem.workspaces.access: read-only` + `--sandbox required` + canary 三条件（文件未创建、`read_nonce` 匹配、`write_result=blocked`）。

4. **Skills / MCP / 全局配置逃逸（P1）**  
   - argv 无法像 Claude/Grok 一样清空 MCP、禁用 skills。  
   - 审议时可能读到用户全局 skills（含 mad 自身 skill），扩大递归与工具面。  
   - 需调研：是否可用 workspace 空配置、环境变量、或官方 settings 覆盖隔离。

5. **轨迹与会话落盘（P2）**  
   - 透明档案外的第二套本地记录；隐私与磁盘；mad 无法关闭时需在文档中披露。

6. **`--unsafe-auto-allow`（P1）**  
   - 非交互必需，但与「自动批准工具」绑定；无沙箱时写盘风险高（canary 已证）。

---

## 8. 建议路径

### 8.1. 短期（不接入 mad）

- 将 Pool 用作**人工/脚本开发工具**（审查、单次任务），与 mad 适配器解耦。  
- 若要用沙箱：先恢复 Docker/OrbStack，再按官方配置 `sandbox:`，用 `/sandbox`（交互）或 canary 脚本验证。

### 8.2. 中期（若要坚持做适配器）

1. 扩展 `publicText` / 必要时专用 `poolPublicText`。  
2. 与 Poolside 确认 **`pool exec` 模型覆盖** 路线（flag 或稳定配置 API）。  
3. 在干净机器跑通 **read-only sandbox canary**；通过后才考虑 `runtime-canary`。  
4. 评估 skills/MCP 隔离；实现 `MAD_PARTICIPANT` + prompt 硬化。  
5. 单测固定 argv：至少  
   `exec --unsafe-auto-allow -o json -d <cwd> -p -`（及未来 model/sandbox 策略）。  
6. `mad config check` 真实预检通过后再谈默认注册表收录。

### 8.3. 不建议

- 在无沙箱下把 Pool 用于 `--workspace` 项目审议。  
- 使用 `--continue` 串联审议轮次。  
- 假设「有 JSON 输出 = publicText 已兼容」。

---

## 9. 验证记录（清单第 12 章模板）

**CLI 名称**：pool（Poolside Agent CLI）

**版本**：1.0.14（215a0738eb）

**验证日期**：2026-07-24

**验证人**：基于清单的本机实测（自动化命令记录）

**验证环境**：macOS；已 login standalone；Docker/OrbStack **未运行**

**参数映射摘要**：

```text
probe: pool --version
non-interactive: pool exec
model: （exec 无；交互 pool -m/--model）
prompt transport: -p | -p - (stdin) | -f file
output format: -o markdown | -o json (NLJSON)
session isolation: 默认一次性；勿用 --continue；有 sessions/trajectories 落盘
tools / sandbox / approvals: --sandbox required|disabled；--unsafe-auto-allow；
  workspace sandbox.filesystem.workspaces.access=read-only；无工具白名单 flag
```

**维度 A（11.1）**：未全部通过（4.3 FAIL；5.1 改码前不可用；6.x PARTIAL/RISK）

**维度 B（11.2）**：不通过 / 当前应声明 unsupported

**publicText / publicError**：**需扩展**（`assistantMessage` + 避免 tool `result` 误判；`error` 字段已基本可用）

**最终判定**：

```text
[ ] 适合一般审议（维度 A）
[ ] 适合项目审议（维度 A + B）
[x] 可接入但需扩展 publicText / publicError
[x] 可接入但项目模式 unsupported（canary 未绿前）
[ ] 不适合作为 mad 适配器
```

补充：**在 exec 级模型固定能力补齐前，即使扩展 publicText，仍不建议合并进默认适配器集。**

**备注 / 风险**：

```text
1. pool exec 无 --model，与 InvocationPreset.model 冲突（P0）
2. 无沙箱 canary 写成功；有沙箱依赖 Docker，本机未实证（P0 for B）
3. skills 发现含 deliberate-with-mad 等，递归面扩大（P1）
4. 每次 exec 写 trajectory/session（P2）
5. 官方文档版本号 1.0.13 vs 本机 1.0.14，flag 以 --help 为准
```

---

## 10. 附录：关键命令与原始结果摘录

### 10.1. READY（markdown）

```bash
pool exec --sandbox disabled --unsafe-auto-allow -o markdown \
  -p "只回复 READY，不要执行任何工具。不要输出其他任何内容。"
# exit 0
# stdout:
# READY
# ⏺ exit(success:true)
```

### 10.2. READY（json）+ publicText

```bash
pool exec --sandbox disabled --unsafe-auto-allow -o json -p "只回复 READY…"
# {"message":"READY","type":"assistantMessage"}
# …
# node: publicText(raw) === ""
```

### 10.3. 模型 flag

```bash
pool exec --model invalid_model_id_xyz_mad_test -p "只回复 READY"
# Error: unknown flag: --model  (exit 1)
```

### 10.4. canary（sandbox disabled）

- 读 nonce 正确  
- `write` 工具创建 `must-not-exist.txt`  
- assistantMessage：`write_result":"succeeded"`  
- **项目只读失败**

### 10.5. canary（sandbox required + read-only settings）

```text
{"error":"validating container environment: failed to ensure main container:
 failed to pull image ubuntu:22.04: Cannot connect to the Docker daemon at
 unix:///Users/libo/.orbstack/run/docker.sock. …"}
```

### 10.6. SIGTERM

长 prompt 睡眠任务，约 4s 后 SIGTERM → `wait` 退出码 1，输出空。

---

## 11. 变更记录

- 2026-07-24：按 [新增CLI适配器验证清单](../../新增CLI适配器验证清单.md) 对本机 pool 1.0.14 全量实测；输出本报告（与旧版静态 [适用性分析.md](适用性分析.md) 并存，结论以本报告为准）。
