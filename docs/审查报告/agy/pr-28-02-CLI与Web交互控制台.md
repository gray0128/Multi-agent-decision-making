# PR #28 CLI 与 Web 交互控制台审查分册 (Antigravity)

**审查日期**：2026-07-23
**审查目标**：PR #28 (`5ec1ac2296c01dcf2d4fe72d6f8ee352f7ee909d`) CLI 入口、Web UI、Schema 与架构一致性
**重点文件**：
- [`src/cli/index.ts`](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts)
- [`src/web/index.ts`](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts)
- [`src/archive/schema.ts`](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/schema.ts)
- [`src/core/types.ts`](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/types.ts)
- [`docs/adr/0018-由审议控制台发起独立审议进程.md`](file:///Users/libo/Documents/github/Multi-agent-decision-making/docs/adr/0018-由审议控制台发起独立审议进程.md)

---

## 1. 发现的问题与改进点

| 编号 | 级别 | 类别 | 源码行号 | 问题描述 | 建议方案 |
|---|---|---|---|---|---|
| **1.1** | **P1** | CLI 安全 | [src/cli/index.ts#L437-L453](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L437-L453) | `--web-plan` 内部选项被暴露为通用命令行参数，可被终端用户利用绕过 `--auto` 模式下必须显式指定 `--auto-confirm-plan` 的安全限制 | 改为内部环境变量（如 `MAD_INTERNAL_WEB_PLAN=1`）传递，禁止 CLI 外部直接输入 `--web-plan` |
| **2.1** | **P1** | Web UI | [src/web/index.ts#L27](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts#L27) | 表单草稿恢复时未先触发 `organizerCli` 改变刷新的 `<option>`，直接设置非默认 CLI 的预设值会静默失败并重置预设 | 回填 `organizerCli` 后先重新渲染 `organizerPreset` 下拉框选项，再回填预设值 |
| **2.2** | **P1** | Web UI | [src/web/index.ts#L29](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts#L29), [L41](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts#L41) | `openArchive` 与 `stream` 异步网络延迟引发竞态条件。快速切换档案时旧 SSE 事件流在后台重启，导致 DOM 事件污染与连接泄露 | 在 `stream` 启动前校验 `selected === id`，若已切换则取消启动 |
| **2.3** | **P1** | 脱敏安全 | [src/core/planning.ts#L207](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/core/planning.ts#L207), [src/cli/index.ts#L300](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/cli/index.ts#L300) | 预检与方案替代校验失败抛出的异常直接暴露 `result.detail` / `error.message`，未经过 `redactAdapterDiagnostic` 脱敏清理 | 抛出与记录错误前统一使用 `redactAdapterDiagnostic` 清理敏感信息 |
| **2.4** | **P2** | Web UX | [src/web/index.ts#L42](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/web/index.ts#L42) | 重新点击当前正在查看的活动审议按钮时，因为 `id === selected` 绕过了 `viewDirty` 未保存修改确认弹窗 | 调整判空逻辑，只要 `viewDirty` 为真即弹出确认 |
| **4.1** | **P2** | Schema 兼容 | [src/archive/schema.ts#L86](file:///Users/libo/Documents/github/Multi-agent-decision-making/src/archive/schema.ts#L86) | Manifest 解析 `reportAgentId` 仅校验 camelCase，缺少对 `report_agent_id` (snake_case) 的回退兼容 | 改为 `raw.reportAgentId ?? raw.report_agent_id` |

---

## 2. 深入审查分析

### 2.1 CLI 与 Web 控制台边界
- **向导三步与参数校验**: 前端控制台三步向导（配置议题/模式 -> Agent/规则与限制 -> 确认发起）体验流畅，`limits` 与 `organizer` 前后端校验规则一致。
- **CLI 越权隐患 (1.1)**: `--web-plan` 原意是让 `LaunchCoordinator` 派生的子进程知道“该进程由 Web 发起，只需完成 Plan 即挂起等待网页信箱”，但该参数在 CLI 选项中公开注册，手打命令即可借此绕过 `--auto-confirm-plan` 安全拦截。

### 2.2 前端交互与安全性
- **敏感字段展示**: 前端 `PublicLaunchCli` 中隐藏了 `executable` 绝对路径与配置 API Key。
- **SSE 事件流竞态 (2.2)**: 快速在列表间切换档案时，`eventAbort.abort()` 在 Fetch 之前调用，而 Fetch 完成后的 `stream(id, ...)` 没有重新判断当前选中项，导致旧连接泄露并将旧事件追加到新页面上。

---

Agent: Antigravity
