# 2026-03-08 useWorkflowExecution session agent single source of truth

## Goal
清理 `useWorkflowExecution` 中仍然硬编码 `DEFAULT_CHAT_AGENT_ID` 的路径，让主会话 agent 真源统一收敛到 `sessionAgentId` / `ownerAgentId`。

## Problem
- 会话元信息已经有 `ownerAgentId`，并且 `WorkflowContainer` 也会使用 `activeDisplaySession.ownerAgentId || sessionAgentId` 作为显示来源。
- 但 `useWorkflowExecution` 内部仍有多处把 `DEFAULT_CHAT_AGENT_ID` 当作真实主 agent：
  - tool policy 获取/更新固定请求 `finger-orchestrator`
  - execution path / execution rounds 默认边仍写死 `finger-orchestrator`
  - 响应解析和 WS fallback agent 也回落到固定默认值
- 结果是：当主会话绑定 agent 改变后，UI 标题、工具暴露、执行路径、消息归属会出现不同步。

## Fix
- `ui/src/hooks/useWorkflowExecution.ts`
  - `resolveMessageRoute()` 的 direct-route 排除条件改为使用 `sessionAgentId`。
  - `refreshToolPanelOverview(agentId?)` 改为请求当前 `sessionAgentId` 对应的 `/api/v1/tools/agents/:agentId/policy`。
  - `updateToolExposure()` 改为更新当前 `sessionAgentId` 的工具策略。
  - hydrate session 时先 `loadSessionMeta()`，再用解析出的 `agentId` 加载 messages 和 tool policy。
  - runtime state 构建中的 orchestrator id / empty state / pending state / executionPath / executionRounds 全部改为使用 `sessionAgentId`。
  - `extractChatReply(..., sessionAgentId)`，避免响应里没有 module 时又退回全局默认值。
- `ui/src/hooks/useWorkflowExecution.runtime.ts`
  - `buildExecutionRoundsFromTasks(tasks, orchestratorId)` 支持外部传入 orchestrator 真源。
- `ui/src/hooks/useWorkflowExecution.ws.ts`
  - `mapWsMessageToRuntimeEvent(msg, sessionId, fallbackAgentId)` 支持显式 fallback agent。
- `ui/src/hooks/useWorkflowExecution.reply.ts`
  - `extractChatReply(result, fallbackAgentId)` 支持显式 fallback agent。

## Validation
- `pnpm --dir ui exec vitest run src/hooks/useWorkflowExecution.agent-source.test.ts src/hooks/useWorkflowExecution.events.test.ts src/components/WorkflowContainer/WorkflowContainer.test.tsx src/components/WorkflowContainer/WorkflowContainer.session-binding.test.tsx`
- `pnpm --dir ui exec vitest run src/hooks/useAgentRuntimePanel.test.ts src/components/LeftSidebar/LeftSidebar.test.tsx src/components/BottomPanel/BottomPanel.test.tsx src/components/AgentConfigDrawer/AgentConfigDrawer.test.tsx`

## Result
- 主会话 agent 的工具策略、执行路径、执行轮次、回复归属和 WS fallback 现在都以 `sessionAgentId` 为单一真源。
- 只在 session 元信息缺失时才退回 `DEFAULT_CHAT_AGENT_ID` 作为兜底，不再把它当成运行时真实来源。

## Follow-up
- 继续收敛 request details / dryrun 展示链路。
- `useWorkflowExecution.sendUserInput()` 现在会把 `requestTargetAgentId`、`roleProfile`、`contextLedger` 写入 requestDetails 元数据，避免右侧“请求详情”继续显示空 roleProfile。
- `ChatInterface` 的请求详情面板新增 `Agent ID` 字段显示，和 dryrun 一样直接暴露发送目标对应的 agent 真源。

## Additional Validation
- `pnpm --dir ui exec vitest run src/components/ChatInterface/ChatInterface.test.tsx src/hooks/useWorkflowExecution.agent-source.test.ts src/hooks/useWorkflowExecution.events.test.ts src/components/WorkflowContainer/WorkflowContainer.test.tsx src/components/WorkflowContainer/WorkflowContainer.session-binding.test.tsx`

## Follow-up Fixes
- `ui/src/hooks/useWorkflowExecution.ts`
  - `interruptCurrentTurn()` 不再请求旧的 `/api/v1/finger-general/sessions/:id/interrupt`。
  - 现在统一走 `/api/v1/agents/control`，并显式提交 `{ action: 'interrupt', targetAgentId: sessionAgentId, sessionId }`。
  - 响应解析改为读取 `result.interruptedCount`，避免新旧返回结构不一致导致 UI 误判。
- `ui/src/components/ChatInterface/ChatInterface.tsx`
  - 停止按钮和暂停按钮 title 不再硬编码 `finger-general`。
  - 新增 `interruptTargetLabel`，由 `WorkflowContainer` 基于当前会话上下文传入：主会话显示当前 orchestrator 名称，子会话显示 runtime agent 名称。
- `ui/src/hooks/useWorkflowExecution.reply.ts`
  - fallback 错误文案从固定 `finger-general request failed` 改为 `${agentId} request failed`，避免错误提示继续污染唯一真源。

## Latest Validation
- `pnpm --dir ui exec vitest run src/components/ChatInterface/ChatInterface.test.tsx src/hooks/useWorkflowExecution.agent-source.test.ts src/hooks/useWorkflowExecution.interrupt.test.ts src/hooks/useWorkflowExecution.events.test.ts src/components/WorkflowContainer/WorkflowContainer.test.tsx src/components/WorkflowContainer/WorkflowContainer.session-binding.test.tsx`
- `pnpm --dir ui exec vitest run src/hooks/useAgentRuntimePanel.test.ts src/components/LeftSidebar/LeftSidebar.test.tsx src/components/BottomPanel/BottomPanel.test.tsx src/components/AgentConfigDrawer/AgentConfigDrawer.test.tsx`

## Tags
Tags: finger, ui, workflow, session-agent, single-source-of-truth, interrupt, dryrun, chatinterface
