# 2026-03-08 runtime session history binding

## Goal
修复子 agent runtime 会话一完成就被 UI 强制切回主会话的问题，保证执行结束后仍可继续查看该子会话历史。

## Root Cause
- `ui/src/components/WorkflowContainer/WorkflowContainer.tsx` 里有一个 runtime binding effect：
  - 当当前绑定的是 runtime session 时，会查找对应 `runtimeInstance`
  - 如果实例状态是 `completed/failed/error/interrupted`，会立即把 `sessionBinding` 重置回 orchestrator
- 这会导致：
  - 子 agent 刚执行完，面板就自动跳回主会话
  - 用户无法继续停留在该子会话上查看完整历史
  - 与“主会话/子会话可独立切换查看历史”的目标冲突

## Fix
- 保留 runtime session 绑定，只有在 `runtimeInstance` 已经不存在时才回退到主会话。
- 不再把 terminal status 视为必须自动跳回主会话的条件。
- 因此：
  - `running -> completed` 后仍然停留在该 runtime session
  - 用户可以继续查看标题、上下文、消息历史
  - 当实例真正消失或绑定失效时，才回退主会话

## Validation
- `pnpm --dir ui exec vitest run src/components/WorkflowContainer/WorkflowContainer.session-binding.test.tsx src/components/WorkflowContainer/WorkflowContainer.test.tsx src/components/ChatInterface/ChatInterface.test.tsx src/components/LeftSidebar/LeftSidebar.test.tsx src/components/BottomPanel/BottomPanel.test.tsx src/hooks/useWorkflowExecution.agent-source.test.ts src/hooks/useWorkflowExecution.interrupt.test.ts`

## Result
- runtime 执行结束后，右侧仍保持该子会话标题与上下文。
- 子会话历史可以继续查看，不会被自动切回 orchestrator。

## Tags
Tags: finger, ui, runtime-session, history, session-binding, workflowcontainer, child-session
