---
status: superseded by ADR-0013
---

# 使用自定义 Workflow 状态机

MVP 使用 Microsoft Agent Framework `WorkflowBuilder` 构建显式审议状态机，而不直接套用 `GroupChatBuilder`。当前流程要求独立观点、阶段内并行、阶段间屏障、用户检查点、整阶段恢复、统一摘要以及报告草拟与审阅，这些都需要明确的节点和状态边界；Group Chat 的优势是动态选择下一位发言者和自然终止，强行模拟固定阶段会抵消其抽象价值。未来若增加自由讨论模式，可将 Group Chat 作为另一种独立编排方式。
