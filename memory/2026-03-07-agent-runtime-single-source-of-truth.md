# 2026-03-07 agent runtime single source of truth

## Goal
修复 Agent 面板状态耦合问题，确保静态配置、运行态实例、会话列表各自只消费一个唯一真源。

## Root Cause
- `useAgentRuntimePanel()` 之前返回单一 `agents` 列表，同时混合了 runtime-view、catalog、agent.json 三种来源。
- `BottomPanel`、`WorkflowContainer`、`LeftSidebar` 分别从这个混合列表里取不同语义的数据，导致：
  - 静态卡片启用状态被 runtime 覆盖。
  - runtime 焦点和静态配置抽屉选择互相干扰。
  - 左侧子 agent 会话列表会被静态配置选择影响，而不是跟随真实 runtime focus。

## Fix
- `ui/src/hooks/useAgentRuntimePanel.ts`
  - 明确拆成 `configAgents` / `runtimeAgents` / `catalogAgents` 三路状态。
  - `configAgents` 由 runtime agent + `agent.json` 合成，但以 `agent.json.enabled`、quota、source 为静态配置真源。
- `src/server/routes/agent-configs.ts`
  - 新增 `PATCH /api/v1/agents/configs/:agentId/enabled`，只修改 `agent.json.enabled`。
  - 禁用时同步触发 runtime undeploy，避免 UI 看到旧 deployment 残影。
- `ui/src/components/BottomPanel/BottomPanel.tsx`
  - 静态卡片只消费 `configAgents`。
  - runtime 指标与连线只消费 `runtimeAgents` 和 `instances`。
  - 启用/禁用按钮只调用新的 enabled patch API，不再在前端拼整份 config。
  - 移除空 `Startup Targets` 占位，避免把不存在的 runtime 目标当成真实配置展示。
- `ui/src/components/WorkflowContainer/WorkflowContainer.tsx`
  - 抽屉 agent 只从 `configAgents` 选中。
  - capabilities 只从 `catalogAgents` 读取。
  - Chat agent/runtime overview 只从 `runtimeAgents` 读取。
- `ui/src/components/LeftSidebar/LeftSidebar.tsx`
  - 子会话列表只跟随 `focusedRuntimeInstanceId` / `activeRuntimeSessionId`。
  - 去掉无效的 `selectedAgentConfigId` 依赖，避免静态配置与 runtime 面板耦合。

## Validation
- `cd ui && npm test -- src/hooks/useAgentRuntimePanel.test.ts src/components/BottomPanel/BottomPanel.test.tsx src/components/WorkflowContainer/WorkflowContainer.test.tsx src/components/WorkflowContainer/WorkflowContainer.session-binding.test.tsx src/components/LeftSidebar/LeftSidebar.test.tsx`
- `cd ui && npm run build`
- `pnpm --dir ui exec vitest run src/hooks/useAgentRuntimePanel.test.ts src/components/BottomPanel/BottomPanel.test.tsx src/components/AgentConfigDrawer/AgentConfigDrawer.test.tsx src/components/WorkflowContainer/WorkflowContainer.test.tsx src/components/WorkflowContainer/WorkflowContainer.session-binding.test.tsx`
- `pnpm exec vitest run tests/unit/blocks/agent-runtime-block.test.ts`
- `pnpm exec tsc --noEmit`
- `pnpm --dir ui exec tsc -b --pretty false`
- `camo start finger-ui-check --url http://localhost:9999 --headless`
- `camo devtools eval finger-ui-check "document.title"`
- `camo screenshot finger-ui-check --output /tmp/finger-ui-check.png`

## Result
- 左侧 Agent Sessions 只显示当前 focused runtime agent 的实例。
- 静态卡片启用/禁用状态不再被 runtime 数据覆盖。
- 静态卡片启用/禁用现在直接落 `agent.json.enabled`，不会因为前端构造整份 config 形状错误而失效。
- 禁用后 runtime deployment 会同步撤销，但静态 agent 卡片仍保留，状态以 `agent.json` 为准。
- 点击上方静态配置卡片不再切走下方 runtime 会话焦点。
