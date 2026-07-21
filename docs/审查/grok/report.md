# 当前实现 vs TypeScript 目标架构 — 审查报告

- **审查主体**：grok（grok-4.5 / high）
- **对照文档**：[docs/TypeScript目标架构.md](../../TypeScript目标架构.md)
- **审查范围**：`src/` 与 `package.json` 当前实现；**刻意忽略** `docs/TypeScript当前实现架构审查.md`、`docs/TypeScript实现与验收.md` 及其他既有审查报告
- **审查时间**：2026-07-21

---

## 1. 结论摘要

| 维度 | 判定 |
|---|---|
| 总体符合度 | **高度符合**（目标架构的主骨架、状态所有权、安全边界已落地） |
| 是否阻塞接管 | **否**（未发现与目标架构硬约束直接冲突的阻断项） |
| 主要缺口 | 中低风险：观察页 Markdown 为轻量自定义解析、组局确认仅终端、部分 ADR 细节实现选择需文档对齐 |
| 风险等级 | **低–中** |

当前 `src/` 单包布局与目标 §3 一致；审议进程独占档案写入、文件信箱检查点、`127.0.0.1` 观察服务、逻辑调用冻结/提交、固定组局阶段、结构化/自由讨论双调度器、七个 CLI 适配器与类型化配置，均与目标架构对齐。

---

## 2. 章节对照矩阵

| 目标章节 | 判定 | 证据位置 | 说明 |
|---|---|---|---|
| §1 目标与约束 | 符合 | `package.json`、`src/cli`、`src/archive`、`src/server` | 单 npm 包；TS 进程写档案；无 Python；无快照；本机绑定 |
| §2 总体结构 | 符合 | 模块划分与 `mad deliberate` / `mad serve` | 审议进程 ↔ 文件信箱 ↔ 观察服务 |
| §3 单包代码结构 | 符合 | `src/{cli,core,adapters,archive,server,web}` | 与目标目录一一对应 |
| §4 CLI 注册表与预设 | 符合 | `src/adapters/config.ts`、`generic.ts`、`codex.ts` | `clis.toml`、无 `extra_args`、两层校验/预检 |
| §5 固定组局阶段 | 符合 | `src/core/planning.ts`、`src/cli/index.ts` | 组局→预检→确认；`--auto-confirm-plan` 仅首次有效方案 |
| §6 CLI 与交互模式 | 符合 | `src/cli/index.ts` `deliberate`/`resume` | `structured`/`free`、`guided`/`auto`、resume 不改模式 |
| §7 结构化审议 | 符合 | `src/core/structured.ts` | 独立→质疑→修订→收敛→报告流水线；检查点四段 |
| §8 自由讨论 | 符合 | `src/core/discussion.ts` | 覆盖周期 + 窗口规划 + 非连续发言 + 成果流水线 |
| §9 资源/并发/上下文 | 符合 | `limits.ts`、`execution.ts`、`context.ts` | 三层限制、双限流、统一滚动摘要 |
| §10 检查点动作 | 符合 | `cli/index.ts` 检查点处理、`mailbox.ts` | 继续/指导/结束/暂停/取消；先写者胜 |
| §11 观察服务与页面 | 基本符合 | `server/observer.ts`、`web/index.ts` | 只读 API + 检查点响应；Markdown 净化为轻量实现 |
| §12 本地认证 | 符合 | `observer.ts` + `APP_JS` | Bearer、fragment → `sessionStorage`、清 hash |
| §13 透明档案 | 符合 | `archive/store.ts` | manifest/state/events/transcript/diagnostics/report |
| §14 恢复与失败 | 符合 | `execution.ts`、`store.ts`、`cli` resume | 逻辑调用边界、双重试、全局锁 |
| §15 工作目录与安全 | 符合 | `cli` workspace 路径、`supportsProjectReadOnly` | 显式 `--workspace`、只读适配器门槛 |
| §16 stdout/stderr/退出码 | 符合 | `cli/index.ts`、`errors.ts` | JSON 单对象、进度进 stderr、分码退出 |
| §17 迁移与接管 | 符合（仓库侧） | 无 `pyproject.toml`/Python 源 | Python 已移除；本审查不核验真实 CLI 验收过程 |
| §18 暂缓决定 | 已有默认值 | `limits.ts` | 默认/安全最大值已写入；属实现选择，非违背 |

---

## 3. 关键约束符合性（高置信）

### 3.1 状态所有权与档案

- `ArchiveStore` 由审议 CLI 进程创建与更新；观察服务只读 `deliberations/*` 与 runtime 检查点请求文件，响应仅写入一次性 `*.response.json`（`publishExclusiveJson`）。
- 档案文件集齐：`manifest.json`、`state.json`、`events.jsonl`、`transcript.jsonl`、`diagnostics.jsonl`、`report.md`。
- 逻辑调用：`freezeInvocation` → 尝试 → `commitInvocation`；重复提交幂等；`InvocationRunner` 最多两次可重试错误。

### 3.2 组局与预检

- 每次审议先经 `OrganizerService.propose`；方案仅允许 `cli`/`preset`/`role`/`id`，禁止裸模型与任意参数。
- 唯一 `cli/preset` 组合去重后 `preflightPlan`；项目模式校验 `supportsProjectReadOnly`。
- `--auto` 强制同时提供 `--auto-confirm-plan`；自动模式只接受首次校验通过方案，不自动改组。
- 共享来源：`sharedOriginWarning` 注入报告与事件，页面展示 `cli/preset`。

### 3.3 双模式调度

**结构化**（`StructuredController`）：

1. 独立陈述 → 2. 质疑补充 → 3. 修订+争议信号 → 4. 有冲突时一次收敛 → 5–7. `OutcomePipeline`（草稿/并行审阅/最终修订）  
guided 检查点：`independent` / `challenge` / `disputes` / `draft`。

**自由讨论**（`DiscussionController`）：

1. 主持覆盖周期（每人恰好一次）  
2. 窗口边界评估收敛并规划下一窗口（长度 = 参与者数；允许重复、禁止连续）  
3. 结束后同一 `OutcomePipeline`；主持调用 `kind: "moderator"`，不计入“观点”。

### 3.4 并发与上下文

- 全局信号量 + 每 CLI `maxConcurrency`（默认 1）。
- `SharedContextManager`：统一摘要 + 摘要后最近记录；由报告 Agent 生成；摘要逻辑调用可恢复（固定 `logicalCallId` 前缀）。

### 3.5 观察服务安全

- 监听 `127.0.0.1`；每次启动新 token；API 需 `Authorization: Bearer`。
- 页面 API 仅列表/详情/SSE 事件/检查点响应；无发起/恢复/删除/改配置入口。
- 先解析文本再 `esc()` 后结构化为有限 HTML 标签，避免未净化 HTML 直注。

### 3.6 工作目录

- 无 `--workspace` 时使用 runtime scratch，非隐式 `cwd` 作为项目材料。
- 有 `--workspace` 时 `realpath` 目录、stderr 警告、manifest 记录 `direct-read-only`。
- 无 `--direct-workspace`、无材料快照实现。
- `reasonix` 适配器 `supportsProjectReadOnly = false`，项目模式被拒绝；其余适配器调用参数偏向 plan/read-only/sandbox。

### 3.7 机器输出与退出码

- 默认 stdout = 最终 Markdown；`--format json` 单 JSON（含 id/status/mode/report/participants/budget_usage/warnings/archive_path）。
- 进度与档案路径 → stderr。
- 退出码：`USAGE=2`、`CONFIG=3`、`PREFLIGHT=4`、`LOCKED=5`、`PAUSED=20`、`CANCELLED=21`、`EXECUTION=30`。

---

## 4. 差距与问题

### 4.1 中风险

| ID | 问题 | 目标依据 | 实现证据 | 影响 | 建议 |
|---|---|---|---|---|---|
| G1 | 观察页 Markdown 为自研正则子集（标题/粗体/行内代码/列表），非独立成熟解析+消毒库 | §11「独立解析与净化」 | `src/web/index.ts` `markdown()` | 复杂 MD（链接、表格、围栏代码）展示残缺；净化路径正确但完备性不足 | 若产品需要完整 MD，引入经审计的解析+消毒；否则在目标/用户文档写明「子集」 |
| G2 | 组局方案交互确认仅终端 `readline`，观察页无法改组/确认方案 | §5 交互确认动作；§11 页面仅检查点 | `confirmPlan` 在 `cli/index.ts` | guided 且无 TTY 时必须 `--auto-confirm-plan`；与「页面只做检查点」一致，但与「交互确认体验统一」预期可能落差 | 保持现状则文档明确「组局确认仅终端」；若产品要页面改组，属目标扩展 |
| G3 | 自由讨论 auto 模式在 `maxDiscussionWindows` 触顶时静默结束讨论并进报告，不强制用户确认 | §8/§10 窗口边界动作 | `discussion.ts` `while` + `atBoundary` 无 checkpoint 时的 auto 路径 | 自动模式符合「按策略继续」，但「结束讨论」语义偏隐式 | 在档案/事件中显式记录 `end_reason: max_windows`（若尚未有） |

### 4.2 低风险 / 实现选择

| ID | 问题 | 说明 |
|---|---|---|
| L1 | 结构化「争议收敛策略」硬编码为「有多立场冲突则跑一轮」 | 目标写「按策略执行一次」；无 CLI 的 always/never/auto 开关。与目标文本文本兼容，但外部 skill/习惯若期待 `--convergence` 则不在本架构正文中 |
| L2 | Token 估算为 `length/4` | 目标未规定算法；粗估可能导致过早/过晚摘要 |
| L3 | 争议主题匹配为 `toLocaleLowerCase` 字面量 | 语义重复主题可能漏检或误检 |
| L4 | `SAFE_MAX`/`DEFAULT` 已固定 | 对应目标 §18「暂缓后校准」——现已有值，应视为产品决策而非缺失 |
| L5 | SSE 推送生命周期事件；正文靠 `invocation.committed` 后整段刷新 transcript | 符合「非 token 流」；实现路径正确 |
| L6 | 配置路径为 `MAD_HOME/config/clis.toml` | 符合目标「长期配置文件为 config/clis.toml」（相对应用数据根） |

### 4.3 已核对未发现违背

- 无 `extra_args` 透传（配置白名单字段；测试覆盖未知字段拒绝）。
- 无页面发起审议/改注册表 API。
- 无局域网监听开关。
- 恢复不重新组局、不切换 mode/interaction（resume 从 manifest 读取）。
- 同一 `MAD_HOME` `ActiveDeliberationLock` 单活动审议。
- 取消可恢复状态区分：`CANCELLED` vs `PAUSED`。
- Ctrl-C → abort → 检查点路径提交 pause。

---

## 5. 模块结构对照

| 目标 | 实现 | 状态 |
|---|---|---|
| `src/cli` | `src/cli/index.ts`（init/config/deliberate/resume/serve/agents） | 齐 |
| `src/core` | planning / structured / discussion / execution / context / outcome / limits / tokens / paths / errors / types | 齐 |
| `src/adapters` | codex + generic（claude/reasonix/grok/pi/codebuddy/agy）+ config/process/public-text | 齐（七适配器） |
| `src/archive` | store + ActiveDeliberationLock | 齐 |
| `src/server` | observer + mailbox | 齐 |
| `src/web` | 内嵌 INDEX_HTML / STYLES_CSS / APP_JS | 齐（无前端框架） |

---

## 6. 按风险排序的修复建议

1. **文档对齐（优先、低成本）**  
   - 明确：组局确认仅终端；观察页 Markdown 子集；auto 自由讨论触顶即进入报告。  
   - 避免读者用其他 skill 文档（如 `--confirm-plan` 别名）覆盖目标架构术语（实现为 `--auto-confirm-plan`）。

2. **可观测性小改（中成本）**  
   - 自由讨论因窗口上限结束时写入明确事件字段。  
   - JSON 输出可考虑附带 `end_reason` / `disputes`（可选，非目标硬性）。

3. **Markdown 展示（按产品需要）**  
   - 若报告频繁含围栏代码/链接，再升级解析净化；否则保持现状可接受。

4. **不建议**  
   - 为对齐外部习惯新增材料快照或 `--direct-workspace`。  
   - 放宽 `extra_args` 或页面写档案。

---

## 7. 审查方法与证据边界

- **方法**：对照 `docs/TypeScript目标架构.md` 全文条款，阅读 `src/**/*.ts` 与 `package.json` 实现路径；使用代码结构与符号调用关系核验，不依赖其他审查报告结论。  
- **未做**：真实七 CLI 端到端 `mad config check`、生产档案回放、浏览器人工点检。  
- **因此**：架构与代码一致性结论置信度高；运行时/接管验收置信度不在本次范围。

---

## 8. 总评

当前实现与《TypeScript 目标架构》**主路径一致**，属于「架构落地后的可维护实现」，而非「半成品骨架」。  
核心不变量（状态唯一写入者、只读项目目录、类型化预设、逻辑调用恢复、检查点信箱、本机认证观察页）均有清晰代码落点。  
剩余问题以**展示完备性与文档预期管理**为主，不构成对目标架构安全模型的否定。

**审查结论：有条件通过（架构一致性通过；产品文档与 Markdown 完备性可后续打磨）。**

---

## 变更记录

- 2026-07-21：首次输出。对照 `docs/TypeScript目标架构.md` 审查 `src/` 当前实现；忽略其他审查报告；报告路径 `docs/审查/grok/report.md`。
- 2026-07-21：按 agent 目录重新整理审查报告（路径未变，补充变更记录）。
