# 2026-03-08 dispatch visibility in runtime panel

## Goal
让主会话/运行态面板对 dispatch 信息更清晰，明确显示“谁派发给谁、当前状态、对应 task”。

## Problems
- 服务端事件转发已经在主会话消息里写入 `派发给 xxx` 文案，但下方 runtime 面板仍只显示通用 `Last Event`，不够直观。
- `BottomPanel` runtime 卡片如果只依赖静态 binding agent，可能读不到 runtime agent 上更准确的 `lastEvent`。

## Fix
- `src/blocks/agent-runtime-block/index.ts`
  - `lastEvent` 增加 `sourceAgentId` 和 `taskId` 字段，dispatch 时一并写入。
- `ui/src/hooks/useAgentRuntimePanel.ts`
  - 解析 `lastEvent.sourceAgentId` / `lastEvent.taskId`。
- `ui/src/components/BottomPanel/agentRuntimeUtils.ts`
  - 新增 `formatDispatchDescriptor()`，统一生成 `source -> target · status · task xxx` 文案。
- `ui/src/components/BottomPanel/BottomPanel.tsx`
  - runtime 卡片优先从 `runtimeAgents` 上读取 `lastEvent`，展示 `Dispatch:` 行。
  - 这样下方 runtime 面板可以直接看出当前 runtime instance 最近一次派发关系。

## Validation
- `pnpm exec vitest run tests/unit/blocks/agent-runtime-block.test.ts`
- `pnpm --dir ui exec vitest run src/components/BottomPanel/BottomPanel.test.tsx src/hooks/useAgentRuntimePanel.test.ts src/components/WorkflowContainer/WorkflowContainer.session-binding.test.tsx src/components/LeftSidebar/LeftSidebar.test.tsx src/components/ChatInterface/ChatInterface.test.tsx`

## Result
- runtime 面板已能明确显示 dispatch descriptor。
- dispatch 文案链路从 block -> hook -> runtime panel 已打通。

## Tags
Tags: finger, dispatch, runtime-panel, bottompanel, last-event, agent-runtime, ui
