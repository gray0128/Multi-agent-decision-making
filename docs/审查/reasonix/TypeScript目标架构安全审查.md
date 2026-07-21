# TypeScript 目标架构安全与健壮性审查 — Claude 视角

> 审查日期：2026-07-21  
> 审查基线：当前工作区 `HEAD`  
> 对照规范：[TypeScript CLI 与审议观察页目标架构](../../TypeScript目标架构.md)  
> 审查者：Reasonix 代写「Claude 安全/健壮性视角」（非 claude CLI 独立运行）  
> 产出目录：`docs/审查/reasonix/`

## 1. 审查范围

本审查聚焦于安全边界、认证授权、进程隔离、错误恢复、输入验证和边界条件。不重复其他审查报告中已覆盖的架构符合性或代码质量问题。

---

## 2. 进程隔离与调用安全

### 2.1 CLI 子进程隔离 — ✅ 良好

**`MAD_PARTICIPANT` 防递归**（`src/cli/index.ts:757-758`）：
```typescript
if (process.env.MAD_PARTICIPANT === "1" && (command === "deliberate" || command === "resume")) {
  throw new MadError("EXECUTION", "禁止从参与者进程递归调用 mad");
}
```
有效阻止了参与者 CLI 通过 side-channel 重新调用 `mad` 导致递归。

**`MAD_PARTICIPANT` 环境变量注入**（`src/adapters/process.ts`）：所有子进程通过 `runProcess` 注入 `MAD_PARTICIPANT=1`。这个守卫是进程级的，不是网络级的——如果参与者 CLI 启动子进程后清除环境变量，仍可规避。但在当前"一次性、非交互 CLI 子进程"的约束下，这一风险可接受。

### 2.2 子进程输出容量控制 — ✅ 良好

`runProcess` 实现了 8 MiB 合并上限（`src/adapters/process.ts`），超限终止整个进程组。该上限对正常审议输出（通常在 10-50 KiB 范围）绰绰有余，同时防止失控 CLI 耗尽主进程内存。

**建议 [P3]**：8 MiB 硬编码在 adapter 层，未与 ResourceLimits 关联。如果未来有适配器需要更大输出（代码生成场景），可能需要可配置。

### 2.3 进程组清理 — ✅ 良好

`runProcess` 使用 `process.kill(-child.pid, "SIGTERM")` 带负 PID 来终止整个进程组。这在超时、显式中止（AbortController）和输出容量超限时都正确使用。SIGTERM → SIGKILL 级联（5000ms 超时后再 `SIGKILL`）确保僵尸进程不会残留。

### 2.4 秘密信息净化 — ⚠️ 有改进空间

**Codex adapter 的 redact**（`src/adapters/codex.ts`）对 stderr 中的 API key、token 和凭证信息做正则替换。但这个净化流程存在于 `publicError()` 的输出处理中，而不是在原始 stderr 进入诊断日志之前。

查看 `InvocationRunner.run()` 的流程（`src/core/execution.ts:163-170`）：
```typescript
await this.archive.appendDiagnostic({
  // ...
  diagnostic: adapterResult.diagnostic,  // ← 这里写入诊断
});
```
`adapterResult.diagnostic` 由各 adapter 的 `invoke()` 方法返回。Codex adapter 在返回前对 `diagnostic.error` 做了 redact，但其他 adapter（generic.ts）的 `runProcess` 返回原始 stderr。`GenericCliAdapter.invoke()` 中：

```typescript
// generic.ts:62-77
const result = await runProcess(cli.executable, args, { /* ... */ });
return {
  text: publicText(result.stdout),      // ← 解析 public text
  diagnostic: {                          // ← 未净化！
    exitCode: result.exitCode,
    stderr: result.stderr,               // ← 原始 stderr
  },
  // ...
};
```

**偏差 C-1 [P2]：Generic CLI adapter 的 stderr 未被净化就写入诊断日志。** 如果 Claude/Grok/Pi/CodeBuddy/agy 的 CLI 在 stderr 中输出 API key 或 internal token，这些信息会以明文持久化到 `diagnostics.jsonl`。虽然有 0o600 权限保护，但不符合纵深防御原则。Codex adapter 做了净化，generic adapter 应该也做。

---

## 3. 认证与授权

### 3.1 Bearer Token — ✅ 良好

- Token 长度：32 字节随机（256 位熵）✅
- 比较方式：`timingSafeEqual`（防时序攻击）✅
- 存储：`sessionStorage`（页面关闭即清除）✅
- 传输：仅通过 URL fragment（不进入服务器日志）✅
- CSP header：`script-src 'self'` + `frame-ancestors 'none'` ✅

### 3.2 路径穿越防护 — ✅ 良好

**审议 ID 验证**（`src/core/paths.ts:assertDeliberationId`）和**观察服务 ID 正则**（`src/server/observer.ts:9:ID = /^[a-zA-Z0-9_-]{1,80}$/`）提供了双层保护：
- `ArchiveStore` 构造时调用 `assertDeliberationId`
- Observer API 中 `/api/deliberations/:id` 路由也校验 ID 格式

**偏差：** 无。CLI 入口的 `resume` 虽然直接使用用户输入构造路径（`src/cli/index.ts:588`），但 `ArchiveStore` 构造时的 `assertDeliberationId` 阻止了路径穿越。之前审查报告中的问题已修复。

### 3.3 档案权限 — ✅ 良好

所有档案文件使用 `mode: 0o600`（仅所有者可读写），目录使用 `mode: 0o700`。`atomicJson` 的临时文件也使用 `0o600`。

---

## 4. 错误处理与恢复

### 4.1 重试策略 — ✅ 良好

`InvocationRunner.run()` 的重试逻辑（`src/core/execution.ts:124-198`）：
1. Node.js 层面错误 → 检查 `MadError` 类型
2. `PAUSED` / `CANCELLED` → 立即抛出
3. 确定性 `MadError`（非 `RetryableMadError`）→ 立即抛出
4. `RetryableMadError`（schema 解析失败）→ 重试一次
5. 其他未知错误 → 重试一次
6. 两次失败后 → 抛出 `EXECUTION`

这与 §14 要求"瞬时错误和 schema 输出错误各自动重试一次"完全一致。

### 4.2 全局锁安全性 — ✅ 良好

`ActiveDeliberationLock` 实现（`src/archive/store.ts:266-338`）：
- `O_EXCL` 创建 → 原子获取 ✅
- 锁文件记录 `ownerId`（UUID）→ 释放时核对所有权 ✅
- stale lock 回收：`kill(pid, 0)` 检测 + `.reclaim` 门闩防竞争 ✅
- 释放时验证 `ownerId` 匹配再 `unlink` ✅

### 4.3 第一份有效检查点响应获胜 — ✅ 良好

`CheckpointMailbox.wait()` 中，终端和观察页通过 `AbortController` 竞速（`src/server/mailbox.ts:62-70`）。一旦一方提交响应，轮询循环检测到后消费，并 abort 另一方。`publishExclusiveJson` 使用 `link()` 系统调用的原子性保证只有一个写入者成功，符合 §10 的约束。

**关注点 [P3]**：如果终端输入刚好在观察页 HTTP 请求到达之前完成，但终端提交先于观察页写入，两者可能产生一个微妙的竞态——终端先提交，但 `publishExclusiveJson` 中观察页的 `link()` 可能比终端的 `link()` 晚，导致 409 返回。`submit()` 已经使用 `publishExclusiveJson` 处理了这种情况，所以实际行为符合 first-wins 语义。

### 4.4 讨论窗口上限时的检查点 — 需确认

查看 `DiscussionController.run()`（`src/core/discussion.ts:130-142`）：
```typescript
while (true) {
  const decision = await this.atBoundary(windows, moderatorPlan);
  if (decision === "end") { converged = moderatorPlan.converged; break; }
  if (windows >= this.plan.limits.maxDiscussionWindows) break;
  windows += 1;
  // ... speak for moderatorPlan.speakers ...
  moderatorPlan = await this.evaluate(...);
}
if (moderatorPlan.converged) converged = true;
```

当 `windows >= maxDiscussionWindows` 时，循环在 `atBoundary` 之后、增加 `windows` 之前退出。`atBoundary` 已经被调用，所以用户在最后一个窗口边界可以看到检查点。✅ 这个已修复。

---

## 5. 输入验证

### 5.1 组局方案解析 — ✅ 严格

`parseDeliberationPlan` 对组局器输出执行全面验证：
- 禁止额外字段（`keysOnly`）✅
- Agent ID 格式验证（`/^[a-z][a-z0-9_-]{0,63}$/`）✅
- 参与者数量范围检查 ✅
- CLI/preset 引用解析 ✅
- 报告 Agent 必须是参与者 ✅
- 主持 Agent 必须是参与者（自由讨论）✅
- 重复 ID 检测 ✅
- 角色字符串长度限制 ✅

禁止字段验证（如 raw `model`、`executable`）有效防止了组局器越权引用不安全配置。这与 §4 的要求一致。

### 5.2 自由讨论主持输出验证 — ✅ 严格

`parseModeratorPlan` 验证：
- `speakers` 数组中所有 ID 都是已知参与者 ✅
- 同一参与者不连续发言 ✅
- 未收敛时要求完整窗口的发言人列表 ✅
- `converged` 必须是布尔值 ✅

### 5.3 最终报告验证 — ✅ 良好

`validateFinalReport` 要求报告包含五个必须部分（Markdown 标题、共识、未决争议、假设、风险）。这属于语义验证而非安全验证，但能防止报告 Agent 输出格式错误的报告。

**建议 [P3]**：如果报告 Agent 输出的是另一种格式（如纯文本不含标题），最终修订会在 `parse` 阶段失败，触发重试，再次失败后审议暂停。这个行为合理，但如果能在 prompt 中更明确地说明输出格式要求，可以减少 schema 失败率。

---

## 6. Web 安全

### 6.1 CSP Header — ✅ 良好

```text
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data:; connect-src 'self';
frame-ancestors 'none'; base-uri 'none'
```

所有资源限制为同源，无 unsafe-inline/eval，禁止 iframe 嵌入。

### 6.2 请求体验证 — ✅ 良好

检查点响应 API 的请求体大小限制 65,536 字节，guidance 字段长度限制 5,000 字符。

**关注点：** 没有请求频率限制。由于服务只监听 `127.0.0.1`，DDoS 风险极低，但如果有恶意本地进程，可以通过高频 SSE 轮询消耗 CPU。500ms 轮询间隔已提供隐式节流。

### 6.3 缓存控制 — ✅ 良好

所有 API 响应使用 `Cache-Control: no-store`，防止浏览器缓存含敏感信息的审议档案。

---

## 7. 数据完整性

### 7.1 原子写入 — ✅ 良好

- `state.json`：`atomicJson()`（temp + rename）✅
- `manifest.json`：同上 ✅
- `report.md`：同上 ✅
- JSONL 文件：`appendFile`（追加操作在 POSIX 上对小写入是原子的）✅
- 检查点响应：`publishExclusiveJson`（temp + link，利用 link 的原子性）✅

### 7.2 Transcript 去重 — ✅ 良好

`ArchiveStore.ensureTranscript()` 先读取现有 transcript，检查 `logicalCallId` 是否存在再追加。使用 `transcriptQueue` 串行化，防止并发追加时的竞态。

---

## 8. 问题汇总

| 编号 | 严重度 | 类别 | 描述 |
|---|---|---|---|
| C-1 | P2 | 秘密净化 | Generic CLI adapter（claude/reasonix/grok/pi/codebuddy/agy）的 stderr 未被净化就写入 diagnostics.jsonl |
| C-2 | P3 | 输出容量 | 8 MiB 输出上限硬编码，未与 ResourceLimits 关联 |
| C-3 | P3 | 频率限制 | 观察服务无请求频率限制（本地监听风险极低） |
| C-4 | P3 | 报告验证 | 最终报告格式要求可更明确地在 prompt 中说明 |

## 9. 总体安全评价

当前实现的安全态势良好：
- **纵深防御**：进程隔离（MAD_PARTICIPANT）+ 文件权限（0o600）+ 认证（Bearer Token）+ CSP
- **输入验证**：所有外部输入（组局方案、主持计划、检查点响应）都经过严格 schema 验证
- **错误处理**：重试策略区分瞬时错误和确定性错误，避免无意义重试
- **原子操作**：关键文件使用 POSIX 原子写入，确保崩溃安全

主要改进方向是**标准化所有 adapter 的秘密净化**，确保 Generic CLI adapter 的错误输出不会意外泄露凭证到持久化诊断日志中。

---

## 变更记录

- 2026-07-21：按 agent 目录重新整理审查报告；修正相对链接与产出归属说明。
