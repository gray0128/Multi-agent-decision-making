---
status: superseded by ADR-0012
---

# DevUI 与命令行入口共用审议引擎

应用同时提供 `serve` 类型的 DevUI 入口和 `deliberate` 类型的命令行入口，两者共用同一套审议用例、Workflow、CLI 适配器、持久化和安全策略。命令行入口供用户及其他 Coding Agent 在具体项目中直接调用：交互终端可以启用阶段检查点，程序化调用默认使用非交互自动模式，进度写入标准错误，最终 Markdown 或 JSON 结果写入标准输出并返回明确退出码。该分层避免 UI 与 CLI 产生两套行为不一致的审议实现。
