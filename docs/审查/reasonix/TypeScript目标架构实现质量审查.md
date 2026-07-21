# TypeScript 目标架构实现质量审查 — Codex 视角

> 审查日期：2026-07-21  
> 审查基线：当前工作区 `HEAD`  
> 对照规范：[TypeScript CLI 与审议观察页目标架构](../../TypeScript目标架构.md)  
> 审查者：Reasonix 代写「Codex 实现质量视角」（非 codex CLI 独立运行）  
> 产出目录：`docs/审查/reasonix/`

## 1. 审查范围

本审查聚焦于实现质量、代码模式、测试覆盖、CLI 适配器正确性和边缘情况处理。不重复其他审查报告中已覆盖的架构符合性或安全问题。

---

## 2. 代码质量评价

### 2.1 整体结构 — ✅ 良好

六个模块的职责分离清晰：

| 模块 | 行数估计 | 评价 |
|---|---|---|
| `cli/index.ts` | ~788 | ⚠️ 过长，建议拆分 |
| `core/*.ts` | ~950 | ✅ 模块化良好 |
| `adapters/*.ts` | ~650 | ⚠️ switch-based，缺乏可扩展性 |
| `archive/store.ts` | ~339 | ✅ 职责单一 |
| `server/*.ts` | ~340 | ✅ 简洁 |
| `web/index.ts` | ~200 | ⚠️ 内联字符串难以维护 |

### 2.2 类型系统使用 — ✅ 优秀

`core/types.ts` 定义了完整的不可变类型层次：
- 使用 `readonly` 修饰符保护数据完整性 ✅
- 使用 `as const` + `typeof` 模式定义联合类型 ✅
- `DeliberationManifest` 支持 `planning` 中间状态（组局中但方案未确认）✅
- `FrozenInvocation` 和 `InvocationResult` 分离关注点 ✅

**细微偏差 [P3]**：`InvocationConfigSnapshot.options` 使用联合类型 `reasoningEffort | effort | thinking`，但这三个字段在类型中都是可选的。如果某个 adapter 同时设置了 `reasoningEffort` 和 `effort`，类型系统不会报错。实际 TOML 配置解析层做了 adapter 级别校验，运行时安全但类型层面不够精确。

### 2.3 错误处理 — ✅ 良好

`MadError` 层级设计：
```
Error
 └── MadError (code: MadErrorCode)  → 确定性错误
      └── RetryableMadError          → 瞬时/Schema 错误
```

退出码映射清晰：`USAGE(2), CONFIG(3), PREFLIGHT(4), LOCKED(5), PAUSED(20), CANCELLED(21), EXECUTION(30)`，符合 §16"不同退出码"要求。

**细微偏差 [P3]**：`isLikelyTransientFailure` 函数已定义但从未在 `InvocationRunner` 的重试逻辑中使用。当前重试基于 `RetryableMadError` 子类判断，regex 启发式函数虽然存在但属于死代码。

---

## 3. CLI 适配器审查

### 3.1 Adapter 接口 — ✅ 设计良好

```typescript
interface CliAdapter {
  readonly supportsProjectReadOnly: boolean;
  probe(cwd: string, signal?: AbortSignal): Promise<AdapterResult>;
  check(cwd: string, signal?: AbortSignal): Promise<PreflightResult>;
  invoke(request: InvocationRequest): Promise<AdapterResult>;
}
```

三个方法职责清晰：probe（存在性检测）→ check（预检）→ invoke（正式调用）。

### 3.2 Codex Adapter — ✅ 实现完整

`CodexAdapter`（`src/adapters/codex.ts`）：
- `codex exec --sandbox read-only --ephemeral --skip-git-repo-check` ✅
- 模型通过 `--model` 传递 ✅
- reasoning 设置通过 `--reasoning-effort` 传递 ✅
- stderr 秘密净化 ✅
- `publicText()` 解析 JSON-line 格式 ✅

### 3.3 Generic Adapter — ⚠️ 有改进空间

`buildInvocationCommand`（`src/adapters/generic.ts`）使用大 switch 语句：

```typescript
switch (adapter) {
  case "claude": return ["-p", "--output-format", "json", "--no-session", "--permission-mode", "plan", prompt];
  case "reasonix": return ["-p", "--output-format", "json", prompt];
  // ... 5 more cases
}
```

**问题 X-1 [P2]：硬编码 CLI 参数，缺乏版本适配能力。** 不同版本的 CLI 可能有不同的参数名或行为。如果 Claude Code 的下一个版本将 `--permission-mode` 改为 `--safety-mode`，需要修改源码并重新发布 npm 包。目标架构 §4 说"每个适配器定义自己的类型化配置 schema"，当前每个 adapter 的文件级别分离存在（codex.ts vs generic.ts），但 generic adapter 内部的 switch 方式将所有 adapter 的差异集中在一个函数中。

**建议：** 将每个 generic CLI 适配器的参数构建逻辑提取到独立文件或配置对象中。

**问题 X-2 [P2]：`reasonix` adapter 的 thinking 剥离。** `publicText()` 中有专门的 `stripReasonixNoise` 正则（`src/adapters/public-text.ts`），负责剥离 Reasonix 的 `thinking`、`metrics` 等内部输出。这个逻辑硬编码在通用文本解析函数中，而不是 Reasonix adapter 特定的输出处理中。当其他 adapter 需要类似的输出清理时，这个耦合会变得脆弱。

### 3.4 `publicText()` 多格式支持 — ✅ 优秀

`publicText()` 能解析 6 种不同的 CLI 输出格式：
1. JSONL 流式行（Claude, Codex）
2. JSON 数组中的 content（Reasonix）
3. 嵌套 depth 累积（CodeBuddy）
4. 直接 JSON 对象
5. 纯文本回退
6. 代码块提取（Grok markdown JSON wrapper）

格式检测逻辑通过特征匹配而非 try-catch 堆叠，设计优雅。

---

## 4. 测试覆盖审查

### 4.1 当前覆盖 — 中等偏上

14 个测试文件，61 个测试通过：

| 测试文件 | 覆盖领域 | 状态 |
|---|---|---|
| `adapters-ts.test.ts` | Adapter 命令构建、文本解析 | ⚠️ 仅 happy path |
| `archive.test.ts` | Archive store、锁操作 | ✅ 较全面 |
| `cli-e2e.test.ts` | 端到端 CLI 流程 | ✅ 关键场景 |
| `config.test.ts` | TOML 配置解析 | ✅ 较全面 |
| `context-manager.test.ts` | 上下文管理 | ⚠️ 未测 token 估算 |
| `discussion.test.ts` | 自由讨论 | ⚠️ 未测 cancel |
| `execution.test.ts` | 调用执行器 | ✅ 关键场景 |
| `init-template.test.ts` | 配置模板生成 | ✅ 基本场景 |
| `interrupt.test.ts` | 中断处理 | ⚠️ 仅 SIGINT |
| `limits.test.ts` | 资源限制 | ✅ 较全面 |
| `mailbox.test.ts` | 检查点信箱 | ✅ 较全面 |
| `observer.test.ts` | 观察服务 | ⚠️ 未测错误路径 |
| `planning.test.ts` | 组局服务 | ✅ 较全面 |
| `structured.test.ts` | 结构化审议 | ⚠️ 并发仅测 1 |

### 4.2 测试缺口详细分析

**缺口 X-3 [P2]：缺少 adapter 错误路径测试。** `adapters-ts.test.ts` 只测试了正常输出的命令构建和文本提取，没有测试：
- CLI 返回非零退出码
- CLI 输出损坏的 JSON
- CLI 超时
- CLI 不可执行（ENOENT）

**缺口 X-4 [P2]：缺少真实 CLI 集成测试。** 所有测试使用 fake adapter 或 mock。没有验证：
- 真实 `codex` CLI 的参数格式是否正确
- 真实 CLI 的输出格式与 `publicText()` 解析器是否匹配
- 超时和中断在实际进程上的行为

**缺口 X-5 [P2]：自由讨论 cancel 动作未测试。** 讨论测试只覆盖了 `continue` 和 `end`，没有测试 guided 用户选择 `cancel`。

**缺口 X-6 [P3]：上下文预算极限未测试。** `context-manager.test.ts` 验证了基本摘要逻辑，但未测试当前上下文极度接近预算时、摘要调用本身超预算的边缘情况。虽然 `SharedContextManager.snapshot()` 有 `if (availableTokens < 32)` 保护，但没有测试触发它的路径。

**缺口 X-7 [P2]：观察服务错误路径未测试。** 没有测试：
- 端口被占用时的启动失败
- 格式错误的 API 请求
- 静态资源不存在（404）

**缺口 X-8 [P3]：并发 > 1 的结构化审议未测试。** `structured.test.ts` 中 `maxConcurrency` 为 1，没有验证多 CLI 真正并行执行的场景。

---

## 5. 边缘情况分析

### 5.1 空审议 — ✅ 已覆盖

- 零 CLI 安装：`init` 生成空骨架 ✅
- 零 CLI 预设：不支持（至少需要 default generator）✅
- 空 guidance 提交：`ArchiveStore.addGuidance` 跳过空字符串 ✅

### 5.2 参与者数量边界 — ✅ 已覆盖

- 最少 2 名（`parseDeliberationPlan:62`）✅
- 最多 `maxParticipants`（默认 4，安全最大 8）✅
- 自由讨论 3+ 人时主持/报告分离建议（prompt 中提示但非硬性）✅

### 5.3 并发边界 — ⚠️ 部分覆盖

`InvocationScheduler` 在 `maxConcurrency = 0` 时会创建 Semaphore(0) 导致死锁。虽然 CLI 配置验证不直接阻止 0 值，但 `resolveLimits` 的 `value < 1` 检查阻止了 `globalConcurrency = 0`。CLI 级别的 `maxConcurrency` 来自 TOML 配置，没有下限检查。

**偏差 X-9 [P3]：CLI `maxConcurrency` 可以设置为 0。** 如果 TOML 中 `[[clis]]` 的 `max_concurrency = 0`，`Semaphore(0)` 将永久阻塞该 CLI 的所有调用。`config validate` 应该拒绝这个值。

### 5.4 超大上下文处理 — ⚠️ 已保护但未充分测试

`SharedContextManager.snapshot()` 有 12 轮迭代上限防止无限循环（`src/core/context.ts:57`）。如果摘要模型无法把上下文压缩到目标以下，审议会以 `EXECUTION` 错误终止。这个行为比静默 OOM 好，但缺少测试覆盖该终止路径。

---

## 6. 性能考虑

### 6.1 SSE 轮询 — ⚠️ 可优化

Observer 的 SSE 使用 500ms `setInterval` 轮询 `events.jsonl`（`src/server/observer.ts:144`）。对于单个本地用户，这完全足够，但可以通过 `fs.watch` 或 `chokidar` 替换为事件驱动方式，消除不必要的文件读取。当前简单实现符合"首版不引入数据库"的约束。

### 6.2 内存使用 — ✅ 合理

- 子进程输出缓存：8 MiB 硬上限 ✅
- 上下文管理：entries 数组按引用存储，摘要后不清理旧 entries（仅通过 `summarizedEntries` 索引跳过）⚠️
- JSONL 文件读取：`readFile` + `split` 整文件读入内存 ✅（假设单次审议的 JSONL 文件在 MB 级别）

**偏差 X-10 [P3]：`SharedContextManager.entries` 不会被 GC。** `summarizedEntries` 指针向前移动后，旧 entries 仍在数组中，只是被 `renderCurrent()` 的 `slice(summarizedEntries)` 跳过。对于非常长的自由讨论（60 次调用，每次 ~2 KiB），entries 数组约 120 KiB，不会成为实际问题。

### 6.3 并发效率 — ✅ 良好

`InvocationScheduler` 使用 Promise 队列而非轮询实现 Semaphore，正确的等待者 FIFO 顺序。

---

## 7. 代码可维护性

### 7.1 正面评价

1. **命名一致性：** 概念命名在整个代码库中一致（`freeze`/`commit`、`invocation`、`checkpoint`）。
2. **类型优先：** 所有公共接口和内部数据结构都有完整类型注解。
3. **单一职责：** `ArchiveStore` 只管理档案，`InvocationRunner` 只管理调用执行，`SharedContextManager` 只管理上下文。
4. **错误码体系化：** `MadError.code` 与 `EXIT_CODES` 的映射使错误处理可预测。

### 7.2 改进建议

1. **拆分 `cli/index.ts`：** 788 行单文件混合了参数解析、生命周期编排和检查点接线。建议：
   - `cli/args.ts`：参数解析
   - `cli/orchestrator.ts`：`deliberate()` 和 `resume()` 流程
   - `cli/checkpoint-wiring.ts`：检查点协调逻辑

2. **提取 Adapter 参数构建：** 将 `buildInvocationCommand` 的 switch 拆分为 per-adapter 工厂函数或配置表。

3. **前端代码分离：** 将内联 HTML/CSS/JS 移到独立文件，使用构建时内联（如 esbuild 的 `--banner`）。

---

## 8. 问题汇总

| 编号 | 严重度 | 类别 | 描述 |
|---|---|---|---|
| X-1 | P2 | Adapter 可扩展性 | `buildInvocationCommand` 的 switch 硬编码所有 CLI 参数，不利于版本适配 |
| X-2 | P2 | 关注点分离 | Reasonix noise 剥离逻辑耦合在通用 `publicText()` 中 |
| X-3 | P2 | 测试覆盖 | 缺少 adapter 错误路径测试 |
| X-4 | P2 | 测试覆盖 | 缺少真实 CLI 集成测试 |
| X-5 | P2 | 测试覆盖 | 自由讨论 cancel 动作未测试 |
| X-7 | P2 | 测试覆盖 | 观察服务错误路径未测试 |
| X-6 | P3 | 测试覆盖 | 上下文预算极限未测试 |
| X-8 | P3 | 测试覆盖 | 并发 > 1 的结构化审议未测试 |
| X-9 | P3 | 边界条件 | CLI `maxConcurrency` 可为 0 导致死锁 |
| X-10 | P3 | 内存 | ContextManager entries 不会 GC（影响极微） |
| — | P3 | 类型精度 | `InvocationConfigSnapshot.options` 联合类型比实际语义宽松 |
| — | P3 | 死代码 | `isLikelyTransientFailure` 定义但未使用 |
| — | — | 可维护性 | `cli/index.ts` 过长，建议拆分 |

## 9. 总体代码质量评价

TypeScript 实现展示了良好的工程质量：
- **类型安全**：充分利用 TypeScript 的类型系统，`readonly`、`as const`、联合类型和泛型使用得当。
- **错误韧性**：重试、恢复和原子操作的设计使系统在进程崩溃后仍能保持一致。
- **测试策略**：14 个测试文件覆盖了核心路径，但边缘情况和错误路径覆盖不足。
- **可维护性**：模块职责清晰，但可进一步拆分大型文件和减少硬编码。

最关键的改进方向是**扩充测试覆盖**（特别是 adapter 错误路径和真实 CLI 集成测试）和**提升 adapter 的可扩展性**（减少 switch-based 硬编码）。

---

## 变更记录

- 2026-07-21：按 agent 目录重新整理审查报告；修正相对链接与产出归属说明。
