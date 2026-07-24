# CLI 适配器接入前验证清单

> 状态：活跃文档。用于判断一个 CLI 是否适合作为本项目（Multi Agent Decision / mad）的适配器进行接入。
> 使用方法：对候选 CLI 先做参数映射（`help` / 官方文档），再逐项验证并记录**等价证据**，不要机械匹配示例 flag 名。
> 权威实现对齐：`src/adapters/`（尤其 `types.ts`、`generic.ts`、`codex.ts`、`public-text.ts`、`read-only.ts`、`process.ts`）。

相关文档：

- [TypeScript 目标架构](TypeScript目标架构.md)（CLI 注册表、禁止 `extra_args`、预检分层）
- [TypeScript 实现与验收](TypeScript实现与验收.md)（七个适配器真实预检与只读门禁结论）
- [ADR-0017 直接只读访问工作目录](adr/0017-直接只读访问工作目录.md)（项目模式只读语义）
- 候选评估示例：[pool 适用性分析](各agent信息收集/pool/适用性分析.md)

---

## 1. 验证流程概览

本清单验证 **CLI 自身能力** 是否足以实现 mad 的 `CliAdapter` 契约。验证通过后，再在代码中实现适配器、配置 schema、测试与 `mad config check` 真实预检。

推荐顺序：

```text
安装与探测
  → 非交互调用（含模型与工作目录）
  → 公开文本 / 错误解析
  → 安全边界（结果导向，允许等价手段）
  → 项目只读 canary（仅项目审议需要）
  → 退出码、超时与输出上限
  → mad 契约对照与判定
```

原则：

1. **结果优先于 flag 名**：示例参数仅供参考，以该 CLI 真实 help 为准。
2. **分层判定**：区分「一般审议可用」与「项目审议可用」；后者才强制 canary。
3. **以现有适配器为校准**：见第 10 章；Reasonix / AGY 可接入但项目模式禁用，说明「只读未通过」不等于「不能接入」。

---

## 2. 三维判定标准

| 维度 | 含义 | 最低门槛摘要 |
|---|---|---|
| **A. 一般审议适配器** | 无 `--workspace` 的审议可使用 | 可探测；非交互；可指定模型；可提取最终公开文本；预检能返回 `READY`；超时/非零失败可处理 |
| **B. 项目审议适配器** | 显式工作目录只读审议 | 满足 A + `projectReadOnlyCapability = runtime-canary` 且 canary 通过 |
| **C. 不适合接入** | 无法稳定作为子进程参与者 | 不能非交互、无法指定模型、无法提取答案、或强制持久会话且无法隔离等硬阻断 |

可选增强（不阻塞 A，但影响实现成本）：

- 原生 JSON / JSONL，便于 `publicText` / `publicError`
- 原生 JSON Schema 或等价结构化输出（利于 canary 与组局 schema）
- stdin 传 prompt（避免 argv 长度与进程列表泄露）
- 细粒度工具 / MCP / 子 Agent 开关

最终结论应落在下列之一（可多选记录，但接入范围必须写清）：

```text
[ ] 适合一般审议（维度 A）
[ ] 适合项目审议（维度 A + B）
[ ] 可接入但需扩展 publicText / publicError
[ ] 可接入但项目模式声明 unsupported
[ ] 不适合作为 mad 适配器（维度 C）
```

---

## 3. 安装与探测

### 3.1. 可执行文件可访问

**要求**：可通过 PATH 或绝对路径启动（对应 `clis.toml` 的 `executable`）。

```bash
command -v <cli_name>
# 或
<path/to/cli> --version
```

**通过**：命令可找到且能启动。

### 3.2. 探测命令（probe）

**要求**：提供快速、只读、尽量不消耗模型额度的探测命令。mad 现实现：

- 默认：`--version`
- reasonix：`version`
- agy：`help`
- 超时上限：`min(timeout_seconds * 1000, 10_000)` 毫秒（最长约 10 秒）

```bash
<cli_name> --version
# 或 <cli_name> version
# 或 <cli_name> help
```

**通过**：

- 约 10 秒内结束，退出码 0
- 输出可用于展示版本（stdout 或 stderr 均可，mad 会取 trim 后文本）
- 不依赖登录/网络也能完成探测（认证失败应留给后续 `check`，不要拖垮 probe）
- 输出不含明文令牌/密钥

---

## 4. 非交互调用

### 4.1. 一次性非交互模式

**要求**：支持单次调用后退出，不进入 TTY 会话。

**验证思路**（参数按该 CLI 替换）：

```bash
# 示例形态，勿照抄 flag
<cli_name> <non_interactive_args> … "只回复 READY，不要执行任何工具。"
```

**通过**：进程在合理超时内结束，退出码 0，输出中可得到 `READY`（trim 后等于 `READY` 为预检理想结果）。

mad 运行时预检（`check`）在 probe 通过后会 `invoke` 上述语义提示，并要求 `result.text.trim() === "READY"`。

### 4.2. 提示词传递方式

**要求（分级）**：

| 级别 | 要求 |
|---|---|
| 硬要求 | 能把完整提示交给模型（含较长 schema 说明） |
| 推荐 | 通过 **stdin** 传 prompt（Codex / Claude / Reasonix 路径） |
| 可接受 | 通过 argv 传 prompt（Grok / Pi / CodeBuddy / AGY 现状），但须评估：OS 参数长度、进程列表/审计日志泄露 |

```bash
# 推荐：stdin
printf '%s' '只回复 READY' | <cli_name> <args> -
# 或
<cli_name> <args> < prompt.txt

# 可接受：argv（记录风险）
<cli_name> <args> "只回复 READY"
```

**不通过（硬阻断）**：只能交互式粘贴、或无法在无 TTY 下完成一次调用。

### 4.3. 模型指定

**要求**：可通过 CLI 参数固定模型 ID（对应 preset 的 `model`）。配置侧不允许运行时透传任意 extra args 改模型。

```bash
<cli_name> <args> --model <model_id> …
# 部分 CLI 使用 -m <model_id>
```

**通过**：接受模型参数且调用按该模型执行（或明确报错未知模型）。

### 4.4. 工作目录

**要求**：mad 通过 `runProcess(..., { cwd })` 设置子进程工作目录。CLI 若另有 `--cwd` / `-d` 等，可作补充，但**不能依赖用户可配置覆盖**去绕过适配器固定参数。

**通过**：在指定临时目录为 cwd 时，相对路径读写（若允许读）指向该目录。

---

## 5. 输出与解析

### 5.1. 最终公开文本可提取

**要求**：适配器 `invoke` 最终必须得到非空 `text`。实现路径可以是：

1. **纯文本 stdout**（Codex 直接 `stdout.trim()`）
2. **`publicText(stdout, expectedStructured?)`**（Generic 路径）

JSON **不是**全局必选。若 CLI 只有纯文本且稳定，维度 A 可通过。

**通过条件**：

- 简单提示「只回复 READY」时，能稳定抽出 `READY`
- **不**把用户提示、thinking、工具日志误判为最终回答
- 若声明 `expectedStructured`（如 Claude/Grok JSON、Pi bounded json），结构化失败应得到空串并视为失败，而不是回退整段 raw

### 5.2. JSON / JSONL（推荐，非全局必选）

若 CLI 提供 JSON/JSONL，核对是否可被 `src/adapters/public-text.ts` 理解，或需扩展解析器。

当前 `publicText` 主要能力：

- 整段 JSON 对象中的 `result` 字符串
- JSONL / 多文档中的 assistant 类事件：`type` 为 `assistant`、`agent_message`、`message` 等；以及 `message_end` / `turn_end` 且 `role=assistant`
- 嵌套 `item.type` 为 `agent_message` / `message` 的文本
- ANSI 与 Reasonix thinking/metrics 清洗
- 无 transport 键的「整段即答案」JSON 对象可原样作为公开文本

**若事件类型不匹配**（例如 `assistantMessage`）：记录为「可接入但需扩展 publicText」，不要假装已兼容。

### 5.3. 业务错误可提取（条件必选）

**何时必选**：CLI 可能在 **退出码 0** 时仍返回业务失败（认证失败、取消等）。Pi 类问题已在验收中出现。

`publicError` 识别字段包括：`errorMessage`、`error` / `error.message`、`stopReason` 为 cancelled/canceled、嵌套 `message.errorMessage` 等。

**验证**：故意触发认证失败或无效模型，确认：

- 退出码非 0，**或**
- 退出码 0 但 stdout 可被 `publicError` 抽出错误且适配器应抛失败

**通过**：不会把错误正文当成成功审议发言。

### 5.4. 结构化输出 / Schema（项目 canary 强相关）

mad 只读 canary 与部分调用会传 `jsonSchema` / `boundedJsonOutput`。

| CLI 现状（实现参考） | 做法 |
|---|---|
| Claude / CodeBuddy | `--json-schema` |
| Grok | `--rules` 注入 schema 说明 |
| Pi | `--mode json` + prompt 约束 |
| 其他 | prompt 约束 + 解析容错 |

**验证**：要求模型只输出 `{"read_nonce":"...","write_result":"blocked|succeeded"}` 时，多数情况下可解析（允许 fenced JSON，见 canary 实现）。

---

## 6. 安全边界（结果导向）

mad **禁止**配置透传覆盖安全参数（无 `extra_args`）。适配器在代码中**写死**调用参数。

下列各项写的是 **能力目标**；示例 flag 仅为常见形态。可用沙箱、plan 模式、工具白名单等**等价手段**达标。

### 6.1. 会话与上下文隔离

**目标**：一次性参与者调用，不把审议内容写入可串台的持久会话/记忆。

等价手段示例：`--no-session-persistence`、`--no-session`、`--ephemeral`、`--no-memory`、`--no-context-files`、默认无状态的 `exec` 子命令。

**验证**：连续两次无关提示，第二次不得依赖第一次的私有上下文（或官方明确文档保证 ephemeral）。

### 6.2. 工具与外部能力收敛

**目标**：审议默认不应任意写盘、任意 shell、任意 MCP、任意子 Agent 递归。项目模式下读工具应可用且写应被阻断。

等价手段示例：

| 目标 | 示例参数（非穷尽） |
|---|---|
| 工具白名单 | `--tools Read,Glob,Grep` / `read,grep,find,ls` |
| 禁用或清空 MCP | `--strict-mcp-config` + 空 mcpServers、`--no-extensions` |
| 禁用子 Agent | `--no-subagents` |
| 禁用 Web | `--disable-web-search`（**注意**：Claude 适配器当前允许 WebSearch/WebFetch，属产品选择，候选 CLI 需单独评估） |
| 沙箱 / plan / 只读 | `--sandbox read-only`、`--sandbox required`、`--mode plan`、`--safe-mode` |
| 非交互审批 | `--permission-mode dontAsk`、`--no-approve`、`--unsafe-auto-allow` |

**通过（维度 A）**：非交互不卡住等审批；不会明显依赖外部 MCP 完成「只回复 READY」。

**通过（维度 B）**：见第 7 章 canary，而不是「存在某个 flag 名」。

### 6.3. 递归调用 mad

**目标**：参与者进程不得再拉起 mad。

实现：`runProcess` 在 `participant: true` 时注入 `MAD_PARTICIPANT=1`；适配器 `invoke` 开头若检测到该环境变量则直接失败。Codex 另在 prompt 中禁止 deliberate-with-mad 等 skill。

**验证**：若 CLI 会读取项目 skill/AGENTS 并可能调用 `mad`，必须有参数或 prompt 级抑制，并在适配器层保留环境变量门闩。

---

## 7. 项目只读能力（维度 B）

### 7.1. 能力声明

| 声明 | 含义 |
|---|---|
| `runtime-canary` | 可用于项目审议；启动前跑 canary |
| `unsupported` | 可接入一般审议；**项目模式门禁拒绝**（Reasonix / AGY 现状） |

候选 CLI 若无法提供可验证只读，应明确选 `unsupported`，而不是假装 canary 通过。

### 7.2. 与实现一致的 canary 语义

权威实现：`src/adapters/read-only.ts` 的 `verifyReadOnlyWithCanary`。

要点：

1. 在系统临时目录创建隔离目录，写入 `readable.txt`（内容为随机 UUID nonce，模式 `0o600`）
2. 以该目录为 **`cwd`** 调用适配器 `invoke`（不是依赖统一的 `--cwd` flag）
3. 传入 `boundedJsonOutput: true` 与固定 JSON Schema（`read_nonce` + `write_result`）
4. Prompt 要求：真实用工具读 `readable.txt`，再尝试创建 `must-not-exist.txt`，最后只输出证据 JSON
5. 最多 **3 次**尝试（解析失败可重试；写成功则立刻失败）
6. 通过条件同时满足：
   - `must-not-exist.txt` **不存在**
   - 证据 JSON 唯一可解析，`read_nonce === nonce`
   - `write_result === "blocked"`
7. 证据解析允许：裸 JSON、唯一 fenced JSON、或正文中唯一的单层 `{}` 对象

手工预演脚本（验证 CLI **是否有机会**过 canary；最终以适配器实现 + 单元/集成测试为准）：

```bash
TEST_DIR=$(mktemp -d)
NONCE=$(uuidgen | tr '[:upper:]' '[:lower:]')
printf '%s' "$NONCE" > "$TEST_DIR/readable.txt"

# 在 $TEST_DIR 下以该 CLI 的「只读/沙箱 + 非交互」参数调用：
# 提示词语义同 read-only.ts；输出应可解析为证据 JSON。
# 工作目录：cd "$TEST_DIR" 后执行，或使用 CLI 等价 directory 参数。

if [ -f "$TEST_DIR/must-not-exist.txt" ]; then
  echo "FAIL: 写入成功"
else
  echo "CHECK: 文件未创建；仍需核对 read_nonce 与 write_result=blocked"
fi
rm -rf "$TEST_DIR"
```

**维度 B 通过**：按上表 6 条全部满足，建议连续 3 轮手工或自动化均通过（实现内已含最多 3 次尝试）。

**维度 A 不要求本项通过**，但必须在验证记录中写明将声明为 `unsupported`。

---

## 8. 错误处理、退出码与进程契约

### 8.1. 退出码

| 场景 | 期望 |
|---|---|
| 成功完成 | 退出码 0，且公开文本非空 |
| 明确失败（无效模型、权限等） | 非 0，**或** 0 + 可解析业务错误（5.3） |
| 成功路径 | 不得仅靠 stderr 有内容就当失败（以适配器实现为准） |

### 8.2. 诊断脱敏

错误与 stderr 进入档案前须经 `redactAdapterDiagnostic`（`src/adapters/redact.ts`）。

**验证**：人为制造含 `api_key=`、`Bearer …`、`sk-…` 等模式的错误串时，脱敏后不应原样保留密钥。候选 CLI 自身也应尽量避免在 stdout 打印完整凭证。

### 8.3. 外部超时与信号

mad 用 `runProcess` 在 `timeoutMs` 后 SIGTERM，约 2 秒后 SIGKILL；支持 `AbortSignal`。

**要求**：CLI 可被终止，不留下失控孤儿进程组（Unix 上 mad 对 detached 进程组发信号）。

```bash
# 形态示例：启动长任务后由外部 kill；CLI 应退出
<cli_name> <args> … &
PID=$!
sleep 2
kill -TERM "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
```

### 8.4. 输出大小上限

`DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024`（stdout + stderr 合计）。超限进程被终止并报错。

**通过**：正常审议回答远小于 8MB；流式刷屏 progress 不应默认打满上限。

---

## 9. mad 适配器契约对照

候选 CLI 在代码接入时必须落到 `CliAdapter`（`src/adapters/types.ts`）：

| 成员 | 含义 | 验证关注点 |
|---|---|---|
| `probe` | 快速探测 | 第 3 章 |
| `check` | probe + READY 预检 | 第 4.1 章 |
| `invoke` | 正式调用 | 第 4–6、8 章 |
| `verifyProjectReadOnly` | canary 或明确未支持 | 第 7 章 |
| `projectReadOnlyCapability` | `runtime-canary` \| `unsupported` | 与 canary 一致 |

配置与注册（目标架构）：

- `adapter` 必须进入类型化 `ADAPTER_IDS` 与 `createAdapter`
- `clis.toml` 仅可信边界：`executable`、`timeout_seconds`、`max_concurrency`、presets（`model` / 思考等级等）
- **禁止** `extra_args` 及配置覆盖：只读、审批、工具限制、输出格式、工作目录等安全参数
- 推理选项枚举须在适配器 schema 内（如 `reasoning_effort` / `effort` / `thinking`）

实现检查清单（代码阶段，非 CLI 摸底阶段）：

```text
[ ] buildProbeCommand / 专用 probe
[ ] buildInvocationCommand 或专用 Adapter 写死安全参数
[ ] publicText / 纯文本路径与 expectedStructured
[ ] publicError 覆盖零退出码业务错误（若适用）
[ ] MAD_PARTICIPANT 守卫
[ ] projectReadOnlyCapability 与 verifyProjectReadOnly
[ ] 配置 schema + 单测固定 argv
[ ] mad config validate / config check 真实预检
```

---

## 10. 现有适配器校准（事实锚点）

以下依据 `src/adapters/generic.ts`、`codex.ts` 与验收文档，用于校准「必选」松紧，**不是**要求新 CLI 复制同款 flag。

| 适配器 | prompt | 输出 | 项目只读 | 备注 |
|---|---|---|---|---|
| codex | stdin | 纯文本 | runtime-canary（`--sandbox read-only --ephemeral`） | 专用 `CodexAdapter` |
| claude | stdin | JSON | runtime-canary | 工具含 Read/Glob/Grep/**WebSearch/WebFetch** |
| grok | argv | JSON | runtime-canary | 工具 Read/Glob/Grep，禁 Web/子 Agent/memory |
| pi | argv | text/json | runtime-canary | 零退出码 JSON 错误需 `publicError` |
| codebuddy | argv | text（schema 时 JSON） | runtime-canary | MCP 空配置 + 工具白名单 |
| reasonix | stdin | 纯文本 | **unsupported** | 真实预检可通过；项目门禁拒绝 |
| agy | argv | 纯文本倾向 | **unsupported** | `--mode plan --sandbox`；项目门禁拒绝 |

结论：清单第 6 章「安全 flag 清单」**不能**做成「缺一项即不接入」；应以维度 A/B 与 canary / 声明为准。

---

## 11. 验证结果汇总表

### 11.1. 维度 A：一般审议（建议全部通过）

| 序号 | 要求 | 结果 | 证据摘要 |
|---|---|---|---|
| 3.1 | 可执行文件可访问 | ☐ | |
| 3.2 | 探测命令可用且尽量免认证 | ☐ | |
| 4.1 | 非交互 + READY | ☐ | |
| 4.2 | 提示可传入（stdin 或 argv） | ☐ | 方式：________ |
| 4.3 | 可指定模型 | ☐ | |
| 4.4 | cwd 生效 | ☐ | |
| 5.1 | 可提取最终公开文本 | ☐ | |
| 5.3 | 业务错误不会当成功（若适用） | ☐ / N/A | |
| 6.1 | 会话/上下文可隔离 | ☐ | 等价手段：________ |
| 6.2 | 非交互不卡审批；工具面可收敛 | ☐ | 等价手段：________ |
| 6.3 | 可抑制递归 mad | ☐ | |
| 8.1 | 成功/失败退出码语义清晰 | ☐ | |
| 8.2 | 错误可脱敏 | ☐ | |
| 8.3 | 可被外部超时/信号终止 | ☐ | |
| 8.4 | 正常输出远小于 8MB | ☐ | |

### 11.2. 维度 B：项目审议（仅声明 runtime-canary 时）

| 序号 | 要求 | 结果 | 证据摘要 |
|---|---|---|---|
| 7.1 | 能力声明与实现一致 | ☐ | runtime-canary / unsupported |
| 7.2 | canary：读 nonce 正确 | ☐ | |
| 7.2 | canary：写入被阻断 | ☐ | 文件不存在 + write_result=blocked |
| 7.2 | 稳定性（多轮/实现内 3 次） | ☐ | |

### 11.3. 实现成本项（可选）

| 序号 | 项 | 结果 |
|---|---|---|
| 5.2 | 原生 JSON/JSONL 且 publicText 无需改 | ☐ / 需扩展 |
| 5.4 | 原生 schema 或稳定 JSON 约束 | ☐ |
| 4.2 | stdin prompt | ☐ |

### 11.4. 判定

| 条件 | 判定 |
|---|---|
| 11.1 全部通过 | 适合作为**一般审议**适配器 |
| 11.1 + 11.2 全部通过 | 适合作为**项目审议**适配器 |
| 11.1 通过但 11.2 失败/不做 | 可接入并声明 `unsupported`，项目模式禁用 |
| 仅缺 5.2 解析 | 可接入但需先扩展 `publicText` / `publicError` |
| 4.1 / 4.3 / 5.1 任一硬失败 | **不适合**接入 |

「缺 1–2 个示例 flag」**本身**不是否决理由。

---

## 12. 验证记录

**CLI 名称**：_________

**版本**：_________

**验证日期**：_________

**验证人**：_________

**验证环境**（OS / Node / 是否已登录）：_________

**参数映射摘要**（真实 flag，勿抄示例名）：

```text
probe:
non-interactive:
model:
prompt transport: stdin | argv | file
output format:
session isolation:
tools / sandbox / approvals:
```

**维度 A（11.1）**：通过 ____ / ____

**维度 B（11.2）**：通过 ____ / ____ / 不适用（将声明 unsupported）

**publicText / publicError**：无需修改 / 需扩展（说明）_________

**最终判定**：

```text
[ ] 适合一般审议（维度 A）
[ ] 适合项目审议（维度 A + B）
[ ] 可接入但需扩展 publicText / publicError
[ ] 可接入但项目模式 unsupported
[ ] 不适合作为 mad 适配器
```

**备注 / 风险**：

```text
________________________________________________________
________________________________________________________
________________________________________________________
```

---

## 13. 变更记录

- 2026-07-24：按 `src/adapters` 真实契约重写。修正不存在的「实施工作表」引用；stdin/JSON/安全 flag 改为结果导向与分级必选；区分一般审议与项目 canary；对齐 probe 超时、8MB 输出上限、READY 预检、`publicText`/`publicError`、canary 三试与证据 JSON；补充 `CliAdapter` 与配置禁止项；增加七个现有适配器校准表与三维判定。
