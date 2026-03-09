# 2026-03-09 General Agent 问题分析

## 当前状态记录

### 1. 空会话与编排者实例问题
- 空会话时 UI 显示有编排者实例
- 需要明确策略：
  - 选项 A：空会话不应该有任何 agent 实例
  - 选项 B：只有使能的 agent 才有实例，禁用的关闭实例

### 2. finger-general 问题
- finger-general 不应该出现在配置中
- 应该作为“+ 号”标准模板，用于创建新 agent
- 正常情况下不应该有这个品类

### 关键发现
- `finger-general` 在以下位置被引用：
  - `src/gateway/gateway-manager.ts` - 网关配置
  - `src/agents/chat-codex/agent-role-config.ts` - 角色映射
  - `src/agents/chat-codex/coding-cli-system-prompt.ts` - 提示词路径
  - `ui/src/hooks/useWorkflowExecution.ts` - UI 显示逻辑

---

## 分析与建议

### 问题 1：空会话实例策略
**建议**：选项 A（空会话无实例）+ 选项 B（使能/禁用控制）
- 空会话时：无任何 agent 实例
- 有会话时：
  - 只有 `enabled: true` 的 agent 启动实例
  - `enabled: false` 的 agent 不启动实例

### 问题 2：finger-general 处理
**建议**：
- 从配置目录中移除 `finger-general`
- UI 中“+ 号”按钮使用 `finger-general` 作为模板
- 保留代码中对 `finger-general` 的引用作为“默认模板”
- 不显示在 agent 配置面板中

Tags: agent, configuration, ui, finger-general, instance-management
