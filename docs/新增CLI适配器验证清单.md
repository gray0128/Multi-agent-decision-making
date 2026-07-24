# 新增 CLI 适配器验证清单

> 状态：活跃文档。每次新增或修改 CLI 适配器时，按本清单逐项验证，缺一不可。
> 相关源码：`src/adapters/`、`src/cli/index.ts`、`tests-ts/`。

## 0. 适配器接入概览

MAD 的 CLI 适配器通过 `CliAdapter` 接口与核心解耦。每个适配器负责：探测可执行文件、构建调用命令、执行子进程、解析公开文本、验证项目只读能力。新增一个 CLI 适配器需要贯穿 **配置注册 → 命令构建 → 输出解析 → 安全验证 → 测试覆盖** 五个环节。

---

## 1. 配置注册

### 1.1 AdapterId 枚举

- [ ] 在 `src/adapters/config.ts` 的 `ADAPTER_IDS` 数组中添加新 ID。
- [ ] 确认 ID 符合 `^[a-z][a-z0-9_-]{0,63}$` 命名模式。
- [ ] 确认 ID 不与现有 `["codex", "claude", "reasonix", "grok", "pi", "codebuddy", "agy"]` 冲突。

```ts
// src/adapters/config.ts
export const ADAPTER_IDS = ["codex", "claude", "reasonix", "grok", "pi", "codebuddy", "agy", "NEW_ADAPTER"] as const;
```

### 1.2 createAdapter 工厂

- [ ] 在 `src/adapters/index.ts` 的 `createAdapter` switch 中添加新 case。
- [ ] 如果新 CLI 复用 `GenericCliAdapter`，将其添加到 `GenericCliAdapter` 分组。
- [ ] 如果需要专属逻辑，创建新的适配器类实现 `CliAdapter` 接口。

```ts
// src/adapters/index.ts
case "new_adapter":
  return new NewAdapter(cli, preset); // 或 new GenericCliAdapter(cli, preset);
```

### 1.3 配置模板

- [ ] 在 `src/adapters/config.ts` 的 `buildConfigTemplate` 中添加新 adapter 的模板段。
- [ ] 模板必须包含 `id`、`adapter`、`executable`、`timeout_seconds`、`max_concurrency` 和至少一个 `preset`。
- [ ] `preset` 中的 `model` 必须是 `REPLACE_WITH_MODEL_ID` 占位符，**不得猜测**真实模型。
- [ ] 如果 adapter 有专属 `options`，在模板中添加相应的注释说明。

### 1.4 预设选项校验

- [ ] 在 `src/adapters/config.ts` 的 `parsePreset` 中，为新 adapter 添加允许的 `options` 字段。
- [ ] 确认 `assertKeys` 能正确拒绝未知字段（例如把 `thinking` 传给 `claude` 会报 `未知字段：thinking`）。
- [ ] 确认枚举值校验（`reasoning_effort`、`effort`、`thinking`）覆盖所有合法值。

### 1.5 初始化探测

- [ ] 在 `src/cli/index.ts` 的 `initialize` 函数中，确认 `ADAPTER_IDS` 自动包含新 adapter。
- [ ] 确认 `buildProbeCommand` 返回正确的探测命令。
- [ ] 运行 `mad init` 后，新 adapter 出现在探测结果中（如果已安装）。

---

## 2. 探测命令（Probe）

### 2.1 探测命令构建

- [ ] 在 `src/adapters/generic.ts` 的 `buildProbeCommand` 中，为新 adapter 添加专属探测命令。
- [ ] 探测命令必须是 **只读、快速、不消耗额度** 的操作（如 `--version`、`version`、`help`）。
- [ ] 探测命令在 5 秒内完成（`runProcess` 的探测超时上限）。

```ts
// src/adapters/generic.ts
export function buildProbeCommand(adapter: CliConfig["adapter"]): readonly string[] {
  if (adapter === "reasonix") return ["version"];
  if (adapter === "agy") return ["help"];
  if (adapter === "new_adapter") return ["--version"]; // 或专属命令
  return ["--version"];
}
```

### 2.2 probe 方法

- [ ] `probe()` 返回 `PreflightResult`：`ready: true` + `version` 字符串，或 `ready: false` + `detail`。
- [ ] 探测失败时，`detail` 经过 `redactAdapterDiagnostic` 脱敏。
- [ ] 探测命令超时或进程异常时，返回 `ready: false` 而非抛出异常。

### 2.3 check 方法（运行时预检）

- [ ] `check()` 先调用 `probe()`，探测失败则直接返回。
- [ ] 探测通过后，执行一次轻量调用，验证 CLI 返回 `READY` 字样。
- [ ] 预检调用必须使用 `--no-session-persistence` 或等效参数，**不得留下会话痕迹**。

---

## 3. 调用命令构建（Invocation）

### 3.1 命令参数

- [ ] 在 `buildInvocationCommand`（或专属适配器类）中，为新 adapter 构建完整参数列表。
- [ ] **必须固定以下安全边界参数**：

| 安全边界 | 说明 |
|---|---|
| 非持久会话 | `--no-session-persistence` / `--no-session` / 等效，防止多轮上下文泄漏 |
| 禁用记忆/历史 | `--no-memory` / `--no-context-files` / 等效，防止历史记录影响审议 |
| 禁用 Web 搜索 | `--disable-web-search` / 等效，防止外部信息污染 |
| 固定工作目录 | `--cwd .` 或 `--dir .`，不得使用其他目录 |
| 固定工具集 | `--tools Read,Glob,Grep` 或等效，限制在只读工具范围 |
| 禁用子 Agent | `--no-subagents` / 等效，防止递归委派 |
| 禁用 MCP | `--strict-mcp-config` + `--mcp-config '{"mcpServers":{}}'` / 等效 |

### 3.2 输出格式

- [ ] 确认 CLI 的输出格式（JSON / JSONL / 纯文本）被 `publicText` 和 `publicError` 正确解析。
- [ ] 如果 CLI 输出 JSON 传输信封（如 `{type:"result", result:"..."}`），确认 `publicText` 能提取最终文本。
- [ ] 如果 CLI 输出 JSONL 事件流，确认 `publicText` 能从 `agent_message` / `message_end` 等事件中提取公开文本。
- [ ] 确认 `publicText` 不会把用户提示误判为模型输出（参见 `directJsonPayload` 逻辑）。
- [ ] 确认 `publicError` 能提取 `errorMessage` / `stopReason` 等错误字段。

### 3.3 模型参数

- [ ] 确认 `--model` 参数使用 `preset.model`，**不得硬编码**。
- [ ] 如果 adapter 支持专属选项（`reasoning_effort` / `effort` / `thinking`），确认参数映射正确。
- [ ] 确认选项参数值来自 `preset.options`，**不得添加额外的 CLI 参数**。

### 3.4 结构化输出（JSON Schema）

- [ ] 如果 adapter 支持 JSON Schema 约束，确认 `--json-schema` 参数正确传递。
- [ ] 如果 adapter 不支持原生 Schema，通过 `--rules` 等方式注入格式要求。
- [ ] 确认结构化输出时，`publicText` 能正确提取最终 JSON。

### 3.5 输入方式

- [ ] 确认 prompt 通过 stdin 传递（`input` 参数），**不得通过命令行参数**（避免长度限制和日志泄露）。
- [ ] 如果 adapter 需要专属系统提示（如 Codex 的参与者提示），确认提示内容正确。

---

## 4. 项目只读能力

### 4.1 能力声明

- [ ] 在适配器构造函数中，正确设置 `projectReadOnlyCapability`。
- [ ] 如果 adapter 有可靠的只读/沙箱开关，声明为 `"runtime-canary"`。
- [ ] 如果 adapter 没有可靠的只读开关（如 Reasonix、AGY），声明为 `"unsupported"`。

```ts
// GenericCliAdapter 示例
this.projectReadOnlyCapability = cli.adapter === "reasonix" || cli.adapter === "agy"
  ? "unsupported"
  : "runtime-canary";
```

### 4.2 只读验证

- [ ] 如果声明为 `"runtime-canary"`，`verifyProjectReadOnly()` 必须调用 `verifyReadOnlyWithCanary`。
- [ ] 验证逻辑：创建临时目录 → 写入 `readable.txt`（含随机 nonce） → 调用 CLI 读取并尝试写入 `must-not-exist.txt` → 检查文件是否被创建 → 验证 nonce 匹配。
- [ ] 验证必须在隔离的临时目录中进行，**不得使用项目目录**。
- [ ] 验证失败时返回 `{ verified: false, detail: ... }`，**不得抛出异常**。

---

## 5. 安全与脱敏

### 5.1 诊断信息脱敏

- [ ] 所有从 CLI 返回的 `stderr` / 错误详情必须经过 `redactAdapterDiagnostic`。
- [ ] 确认 `redactAdapterDiagnostic` 能识别以下模式：
  - `api_key=xxx`、`token=xxx`、`password=xxx` 等键值对
  - `Bearer xxx` 格式的 Bearer Token
  - `sk-xxx`、`xai-xxx`、`ghp-xxx`、`github_pat_xxx`、`glpat-xxx` 等常见 Token 前缀
  - 环境变量中包含 `TOKEN`、`KEY`、`SECRET`、`PASSWORD` 的值

### 5.2 参与者进程防护

- [ ] 在 `invoke()` 方法开头，检查 `process.env.MAD_PARTICIPANT === "1"`，如果为 1 则抛出 `MadError("EXECUTION", "禁止从参与者进程递归调用 mad")`。
- [ ] 确认 `runProcess` 在 `participant: true` 时，会在子进程环境中设置 `MAD_PARTICIPANT=1`。

### 5.3 输出大小限制

- [ ] 确认 `runProcess` 的 `maxOutputBytes`（默认 8MB）能有效限制 CLI 输出大小。
- [ ] 输出超过限制时，进程被终止并返回 `MadError("EXECUTION", "输出超过上限")`。

---

## 6. 错误处理

### 6.1 非零退出码

- [ ] 非零退出码时，提取 `stderr`（或 `stdout` 作为 fallback）并脱敏。
- [ ] 根据 `isLikelyTransientFailure` 判断是否为 `RetryableMadError`。
- [ ] 错误消息格式：`{cliId} 调用失败（退出码 {exitCode}）：{detail}`。

### 6.2 零退出码但业务错误

- [ ] 使用 `publicError` 从 JSON 输出中提取错误信息。
- [ ] 确认 `stopReason` 为 `cancelled`/`canceled` 时，分类为 `RetryableMadError`。
- [ ] 确认 `errorMessage` 等字段被正确提取和脱敏。

### 6.3 空输出

- [ ] 如果 `publicText` 返回空字符串，抛出 `MadError("EXECUTION", "{cliId} 未返回公开文本")`。

---

## 7. 测试覆盖

### 7.1 单元测试（`tests-ts/adapters-ts.test.ts`）

- [ ] **探测命令测试**：`buildProbeCommand("new_adapter")` 返回正确命令。
- [ ] **调用命令测试**：`buildInvocationCommand` 为新 adapter 生成正确的参数，特别是：
  - 包含 `--model` 和 `preset.model`
  - 包含所有安全边界参数（非持久、禁用记忆、禁用 Web 搜索等）
  - 专属选项参数正确映射
- [ ] **只读能力测试**：`new GenericCliAdapter(cli("new_adapter"), preset).projectReadOnlyCapability` 返回正确值。
- [ ] **输出解析测试**：`publicText` 和 `publicError` 能正确处理新 adapter 的输出格式。

### 7.2 配置测试（`tests-ts/config.test.ts`）

- [ ] **模板测试**：`buildConfigTemplate(["new_adapter"])` 生成合法 TOML，包含正确的结构。
- [ ] **选项校验测试**：确认新 adapter 只接受合法的 `options` 字段，拒绝未知字段。
- [ ] **占位符测试**：`model = "REPLACE_WITH_MODEL_ID"` 被正确拒绝。

### 7.3 只读验证测试（`tests-ts/read-only.test.ts`）

- [ ] 如果 adapter 声明为 `"runtime-canary"`，添加只读 canary 验证测试。
- [ ] 测试场景：正确读取 nonce + 写入被阻断 → `verified: true`
- [ ] 测试场景：写入成功 → `verified: false`
- [ ] 测试场景：nonce 不匹配 → `verified: false`
- [ ] 测试场景：多个证据块 → `verified: false`（fail-closed）

### 7.4 端到端测试（`tests-ts/cli-e2e.test.ts`）

- [ ] 如果可能，使用 `fake-codex.sh` 模拟脚本测试新 adapter 的完整调用链。
- [ ] 确认 `mad config check` 能成功预检新 adapter。

---

## 8. 文档更新

### 8.1 README

- [ ] 在 README 的 CLI 列表中添加新 adapter。
- [ ] 在安全边界说明中，确认新 adapter 的固定参数被正确描述。

### 8.2 配置示例

- [ ] 在 `docs/config示例/clis.toml` 中添加新 adapter 的配置示例。
- [ ] 包含真实可用的模型 ID 和 `context_budget`。
- [ ] 添加模型规格注释（context / output 限制）。

### 8.3 Agent 信息收集

- [ ] 在 `docs/各agent信息收集/` 目录下，为新 adapter 创建模型与参数信息文档。
- [ ] 记录支持的模型列表、思考等级、上下文预算等信息。
- [ ] 核验日期和信息来源。

---

## 9. 验收命令

完成所有修改后，运行以下命令验证：

```bash
npm run typecheck    # TypeScript 类型检查
npm test             # Vitest 单元测试
npm run build        # TypeScript 构建
```

### 验收标准

| 验证 | 要求 |
|---|---|
| TypeScript 类型检查 | 通过，无错误 |
| Vitest | 所有测试通过，包括新增测试 |
| TypeScript 构建 | 通过 |
| `mad init` | 新 adapter 出现在探测结果（如果已安装） |
| `mad config validate` | 新 adapter 的配置静态校验通过 |
| `mad config check` | 新 adapter 的运行时预检通过（如果 CLI 已安装并配置） |

---

## 10. 常见问题排查

### Q1. `mad config validate` 报 `未知字段`

- **原因**：`parsePreset` 中的 `assertKeys` 不允许新 adapter 的 `options` 字段。
- **解决**：在 `parsePreset` 的 `allowedOptions` 中添加新字段。

### Q2. `publicText` 返回空字符串

- **原因**：CLI 输出格式不被 `publicText` 识别，或输出被当作 JSON 传输信封解析。
- **解决**：检查 CLI 的输出格式，确认 `directJsonPayload` 逻辑是否正确处理。

### Q3. 只读验证失败

- **原因**：adapter 没有真正的只读/沙箱模式，或写入未被阻断。
- **解决**：确认 adapter 的安全参数正确，或将 `projectReadOnlyCapability` 设为 `"unsupported"`。

### Q4. 探测超时

- **原因**：探测命令需要交互或耗时过长。
- **解决**：更换为无交互、快速的探测命令（如 `--version`）。
