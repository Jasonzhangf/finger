# 2026-03-08 child session history and dispatch visibility

## Goal
继续收敛“主会话/子会话隔离 + 子会话历史可见 + dispatch 在子会话中不丢失”。

## Problems
- 左侧 `Agent Sessions` 之前主要依赖 `runtimeInstances`，当 runtime instance 不再出现在运行态列表时，历史子会话会直接消失。
- 右侧子会话按 agent 过滤消息时，dispatch 事件如果同时包含 `sourceAgentId` 和 `targetAgentId`，需要确保目标子 agent 会话下仍可看到，不被错误过滤掉。

## Fix
- `ui/src/components/LeftSidebar/LeftSidebar.tsx`
  - `Agent Sessions` 改为同时消费两路真源：
    - 运行态实例 `runtimeInstances`
    - 已持久化会话 `sessions` 中的 runtime child sessions
  - 当 runtime instance 已消失但 session 仍存在时，仍生成历史项并展示。
  - 历史项默认状态显示为 `已完成`，并继续使用 `ownerAgentId` + config/runtime display name 做展示。
- `ui/src/components/ChatInterface/ChatInterface.tsx`
  - agent 过滤逻辑由“只取单个 resolvedAgentId”改成“收集 `agentId / metadata.event.agentId / targetAgentId / sourceAgentId` 多个候选 id”。
  - 只要当前 `eventFilterAgentId` 命中任一候选 id，就保留该事件。
  - 这样 dispatch 事件在子 agent 视角不会因为同时带 source/target 而被过滤掉。

## Validation
- `pnpm --dir ui exec vitest run src/components/LeftSidebar/LeftSidebar.test.tsx src/components/ChatInterface/ChatInterface.test.tsx src/components/WorkflowContainer/WorkflowContainer.session-binding.test.tsx src/components/WorkflowContainer/WorkflowContainer.test.tsx`

## Result
- 已完成的子 agent 会话，在左侧 `Agent Sessions` 中仍可见并可重新切换查看。
- 子 agent 会话过滤后仍可看到与自己相关的 dispatch 事件。

## Tags
Tags: finger, ui, child-session, history, dispatch, chatinterface, leftsidebar, single-source-of-truth
