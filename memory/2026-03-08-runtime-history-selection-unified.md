# 2026-03-08 Runtime History Selection Unified
Tags: runtime-session, child-session, left-sidebar, bottom-panel, single-source-of-truth, dispatch-visibility

## Context
继续收敛主会话 / 子会话 / runtime instance 的唯一真源显示与切换，重点是：
- 左侧 `Agent Sessions` 不能只依赖活跃 runtime instance
- 子 agent 历史会话完成后仍要可见、可切换
- 下方 runtime 卡片要明确展示 dispatch 来源、目标和 taskId

## Changes
- `ui/src/components/LeftSidebar/LeftSidebar.tsx`
  - runtime session 列表改为合并两类真源：
    - 当前活跃 `runtimeInstances`
    - `sessions` 里的 runtime child sessions
  - 以 `sessionId` 去重，保证活跃实例和历史会话不会重复出现
  - 仅在当前 project 下展示，且继续尊重 focused runtime agent 过滤
- `ui/src/components/WorkflowContainer/WorkflowContainer.tsx`
  - 统一 runtime 会话切换入口为 `handleSelectRuntimeSession`
  - 左侧 sidebar 和下方 bottom panel 都走同一切换函数
  - runtime 完成/失败后不自动弹回主 orchestrator，会保留在子会话上看历史
- `ui/src/components/ChatInterface/ChatInterface.tsx`
  - 子会话过滤事件时，同时识别 `agentId / metadata.event.agentId / targetAgentId / sourceAgentId`
  - 避免 dispatch 事件因为 source/target 双 agentId 结构被过滤掉
- `src/blocks/agent-runtime-block/index.ts`
  - runtime view 的 `lastEvent` 增加 `sourceAgentId` 和 `taskId`
- `ui/src/hooks/useAgentRuntimePanel.ts`
  - 解析 runtime view 里的 `sourceAgentId` / `taskId`
- `ui/src/components/BottomPanel/agentRuntimeUtils.ts`
  - 新增 `formatDispatchDescriptor()`
- `ui/src/components/BottomPanel/BottomPanel.tsx`
  - runtime 卡片展示 `Dispatch: source -> target · status · task ...`

## Validation
- `pnpm --dir ui exec vitest run src/components/BottomPanel/BottomPanel.test.tsx src/hooks/useAgentRuntimePanel.test.ts src/components/WorkflowContainer/WorkflowContainer.session-binding.test.tsx src/components/LeftSidebar/LeftSidebar.test.tsx src/components/ChatInterface/ChatInterface.test.tsx`
  - 48 tests passed

## Live UI Evidence
- 使用 `camo` 访问 `http://127.0.0.1:9999`
- 发现并确认：右侧 chat 输入区可用，但 bottom panel 高度把 composer 挤出视口，导致发送按钮最初不可点击；手动收起 bottom panel 后可恢复输入/发送
- 实际发送了一条 orchestrator 消息后，页面追加了用户消息与 agent 回复；当前真实链路被 provider 配额 `402 daily_cost_limit_exceeded` 阻断，因此无法完成 dispatch->executor 全链路截图
