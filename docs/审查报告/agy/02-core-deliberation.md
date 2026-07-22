# 核心审议与组局逻辑合规性审查报告

本报告针对 `Multi-agent-decision-making` 项目的 TypeScript 实现中，核心审议逻辑、组局规划、结构化审议、自由讨论以及资源/并发/上下文限制等模块，对照 `docs/TypeScript目标架构.md` 第 5、7、8、9 章节的规范要求进行独立合规性审查。

---

## 1. 审查范围与方法

### 1.1 审查范围
本次审查主要覆盖以下文件及其实际行为：
- **核心逻辑实现文件**：
  - [src/core/planning.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts) (组局规划、预检与安全检查)
  - [src/core/structured.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts) (结构化审议流程控制)
  - [src/core/discussion.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts) (自由讨论流程控制与主持 Agent 调度)
  - [src/core/context.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/context.ts) (上下文管理与统一滚动摘要)
  - [src/core/execution.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts) (调用调度、逻辑执行与并发限流)
  - [src/core/limits.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/limits.ts) (三层资源上限校验)
  - [src/core/outcome.ts](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/outcome.ts) (报告生成、评审与防多角色串通规则)
- **单元与集成测试文件**：
  - `tests-ts/planning.test.ts`
  - `tests-ts/structured.test.ts`
  - `tests-ts/discussion.test.ts`
  - `tests-ts/limits.test.ts`
  - `tests-ts/context-manager.test.ts`
  - `tests-ts/execution.test.ts`

### 1.2 审查方法
1. **源码走读**：逐行分析逻辑代码中关于组局白名单、阶段屏障、自由讨论窗口调度、资源/并发限速、统一滚动摘要以及逻辑调用恢复的实现。
2. **测试验证**：运行项目所有的 TypeScript 测试，确保测试覆盖度并分析测试用例中对各种异常、重试、恢复、限制的断言是否满足规范要求。
3. **架构对齐检查**：对照 §5、§7、§8、§9 的每个具体条款，寻找代码级证据进行映射和校验。

---

## 2. 符合性检查项 (Conforming Items)

### 2.1 固定组局阶段合规性 (§5)
1. **组局器解析与覆盖**：
   - 实现了默认组局器解析以及按次覆盖功能。
   - **代码证据**：[src/core/planning.ts L132](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L132) 实现了 `const organizer = request.organizer ?? this.registry.defaults.generator;`。
2. **注册表安全视图**：
   - 组局器提示词中仅包含安全视图（仅 cli ID、adapter、presets，不包含可执行文件路径、参数、环境变量等敏感信息）。
   - **代码证据**：[src/core/planning.ts L220-235](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L220-L235) 中的 `buildPrompt` 过滤并构建了 `registryView`。
3. **Agent 独立实例定义**：
   - 生成的参与者方案包括唯一 ID、CLI 配置、调用预设和角色描述，并防范了非法字段。
   - **代码证据**：[src/core/planning.ts L69-80](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L69-L80) 严格使用 `keysOnly` 进行字段白名单校验。
4. **报告与主持 Agent 的角色约束**：
   - 保证报告 Agent（以及自由讨论中的主持 Agent）必须属于参与者之一。
   - **代码证据**：[src/core/planning.ts L83-84, L93-94](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L83-L84) 校验 `ids.includes(reportAgentId)` 与 `ids.includes(moderatorAgentId)`。
5. **调用组合去重预检**：
   - 运行时先对每个不同的 `CLI 配置 + 调用预设` 组合进行一次预检，避免对共享组合的多个 Agent 重复预检。
   - **代码证据**：[src/core/planning.ts L184-200](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L184-L200) `preflightPlan` 使用 Map 对 `key = \`${participant.invocation.cli}/${participant.invocation.preset}\`` 进行去重预检。
6. **交互式方案确认与修改**：
   - 支持回车确认、输入完整 JSON 修改方案、通过 `/regroup 指导` 重新组局以及 `/cancel` 取消。
   - **代码证据**：[src/cli/index.ts L198-262](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L198-L262) 实现的 `confirmPlan` 循环读取终端输入，处理 `/regroup` 重新触发规划，并重新预检。
7. **非交互自动确认**：
   - 显式传入 `--auto-confirm-plan` 时，自动接受第一次有效组局方案，无交互终端且未使用该参数时将报错退出。
   - **代码证据**：[src/cli/index.ts L401-402, L496-515](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L401-L402) 中对 guided 模式无终端与 `--auto-confirm-plan` 要求的强制校验。
8. **共享来源警告提示**：
   - 如果多个 Agent 共享相同的 CLI 与调用预设，会在生成报告时追加警告，并在提示词中要求不得把一致意见描述为独立模型交叉验证。
   - **代码证据**：[src/core/outcome.ts L6-14](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/outcome.ts#L6-L14) 的 `sharedOriginWarning`，以及 [src/core/outcome.ts L51-53, L90-91](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/outcome.ts#L51-L53) 对该警告的直接组装。

### 2.2 结构化审议流程合规性 (§7)
1. **7个明确阶段与逻辑并行屏障**：
   - 实现包含：(1) 独立陈述、(2) 质疑与补充、(3) 修订意见与关键争议信号、(4) 争议收敛、(5) 报告草稿、(6) 参与者审阅、(7) 报告最终修订。
   - 同一阶段的参与者并行执行逻辑调用（通过 `settleAllOrThrow` 确保屏障同步），且当前阶段未完成的输出对其他参与者不可见。
   - **代码证据**：[src/core/structured.ts L91-155](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts#L91-L155) 的 `run` 方法逻辑流，[src/core/structured.ts L171-182](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts#L171-L182) 的 `parallel` 辅助方法。
2. **引导模式检查点 (Guided Checkpoints)**：
   - 在独立陈述后 (`independent`)、质疑补充后 (`challenge`)、争议判定后 (`disputes`) 以及报告草稿生成后 (`draft`) 等四个关键阶段，自动等待用户选择继续、指导后继续、暂停或取消。
   - **代码证据**：[src/core/structured.ts L95, L106, L132, L152](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/structured.ts#L95) 中的 `pauseAt` 调用。

### 2.3 自由讨论流程合规性 (§8)
1. **一次性主持 Agent 调度**：
   - 主持 Agent 不使用长期 CLI 进程或私有会话，而是在覆盖周期开始和每个检查窗口边界通过一次性 CLI 调用规划发言。
   - **代码证据**：[src/core/discussion.ts L119-128](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L119-L128) 进行覆盖周期规划调度，[src/core/discussion.ts L197-220](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L197-L220) 进行窗口评估调度。
2. **主持调用计入总调用预算，但不属于发言内容**：
   - 主持调用的 logicalCallId 分别为 `discussion:moderator:coverage` 和 `discussion:moderator:window:${window}`，其结果不计入 `speeches` 发言记录。
   - **代码证据**：[src/core/discussion.ts L119, L210](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L119) 通过 runner 发起逻辑调用（因此计入 callAttempts 与 maxCalls），但没有 push 到 `speeches` 数组中。
3. **覆盖周期与发言防连续规则**：
   - 覆盖周期要求每位参与者恰好发言一次。
   - 随后的开放讨论允许重复选择参与者，但同一参与者不能连续发言（包括窗口首位不能是上一窗口末位）。
   - **代码证据**：覆盖周期校验见 [src/core/discussion.ts L48-56](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L48-L56) 的 `parseCoverage`；非连续性校验见 [src/core/discussion.ts L71-76](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L71-L76) 的 `parseModeratorPlan`（`speaker === previous` 抛错）。
4. **讨论窗口边界评估与检查点**：
   - 每个窗口包含与参与者数量相同的发言回合。
   - 窗口边界处调用主持 Agent 评估收敛性，并在 guided 模式下等待用户响应检查点（允许继续、补充指导、结束讨论 `/end`、暂停 `/pause` 或取消 `/cancel`）。
   - **代码证据**：[src/core/discussion.ts L133-148](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L133-L148) 循环，[src/core/discussion.ts L222-248](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L222-L248) 的 `atBoundary` 方法。
5. **共同成果流水线复用与报告格式校验**：
   - 自由讨论结束后，进入 OutcomePipeline 生成、审阅和确认报告。
   - 生成的报告使用 `validateFinalReport` 校验 Markdown 标题以及 `共识/未决争议/假设/风险` 结构。
   - **代码证据**：[src/core/discussion.ts L158-163](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/discussion.ts#L158-L163) 复用 `OutcomePipeline`；[src/core/outcome.ts L20-32](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/outcome.ts#L20-L32) 进行 final report 结构正则匹配强制校验。

### 2.4 资源、并发与上下文管理合规性 (§9)
1. **三层资源上限校验**：
   - 区分保守默认值 (`DEFAULT_LIMITS`) 和安全最大值 (`SAFE_MAX_LIMITS`)，并通过 `resolveLimits` 进行越界校验。
   - **代码证据**：[src/core/limits.ts L4-31](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/limits.ts#L4-L31) 实现了该机制。
2. **并发控制 (双层 Semaphore)**：
   - 实现了全局限流器与 CLI 配置级限流器共同控制的排队机制。
   - **代码证据**：[src/core/execution.ts L40-56](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L40-L56) `InvocationScheduler` 使用嵌套 semaphore 逻辑：`local.use(() => this.global.use(operation))`。
3. **输入 token 估算与统一滚动摘要**：
   - 每次调用前，如果估算的输入 tokens 超过该 presets 允许 of contextBudget 约束，则通过报告 Agent 启动分段摘要压缩。
   - 滚动摘要对所有参与者、主持 Agent 和报告 Agent 完全统一，生成计入预算，且可独立恢复（带有独特的 `context:summary:...` 逻辑调用 ID 缓存与重试校验）。
   - **代码证据**：[src/core/context.ts L47-101](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/context.ts#L47-L101) 的 `snapshot` 方法，以及 [src/core/execution.ts L106-113](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/execution.ts#L106-L113) 对 `inputTokens > contextBudget` 的前置抛错校验。

---

## 3. 偏差与问题 (Deviations / Issues)

经过细致的静态代码走读和测试集验证，未在当前 core deliberation 逻辑实现中发现偏离架构规范的具体问题。
- **并发控制** 完美采用了双层 Semaphore 阻塞模型。
- **输入超量与摘要生成** 的行为在 `tests-ts/context-manager.test.ts` 中有充分的边缘情况覆盖。
- **暂停与恢复** 依托于 logicalCallId 机制，保证了即使在多轮重试、崩溃恢复后，均能以逻辑调用为单位，只重跑未完成的部分。

---

## 4. 总结与评分 (Summary and Rating)

### 4.1 审查总结
`src/core/` 目录下的 TypeScript 重构版本不仅完全剔除了旧版遗存，而且在所有细节设计上完全满足了架构文档的严苛规定：
- 组局器实现了完美的“三权分立”与“输入安全”，确保其只具备读工作目录、读配置骨架的最小权限，生成的方案符合 Whitelist 逻辑。
- 并发控制和上下文预算计算严丝合缝，有效规避了潜在的大量 API 调用阻塞与超出窗口大小报错。
- 逻辑调用（Logical Invocations）的冻结与原子提交机制保证了流程中任意点被 `Ctrl-C` 暂停后的无损恢复。

### 4.2 评分
- **Organizing Phase (组局阶段)**: ★★★★★ (优秀，完美符合)
- **Structured Deliberation (结构化审议)**: ★★★★★ (优秀，完美符合)
- **Free Discussion (自由讨论)**: ★★★★★ (优秀，完美符合)
- **Resource, Concurrency & Context (资源与并发限制)**: ★★★★★ (优秀，完美符合)
- **整体评级**: **Conformant (完全合规)**
