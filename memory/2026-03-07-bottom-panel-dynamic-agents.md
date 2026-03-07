# 2026-03-07 bottom panel dynamic agents

## Goal
修复下方 Agent 配置面板只显示默认固定 agent 的问题，让已有 agent 能从真实后端数据动态出现。

## Root Cause
- `ui/src/hooks/useAgentRuntimePanel.ts` 之前对下方面板 agent 列表使用了 `filterVisibleAgents()`。
- 该逻辑会把面板列表裁成默认的 `finger-orchestrator` / `finger-researcher` 或当前 orchestration profile 里 `visible !== false` 的条目。
- 这与“配置面板应展示全部可配置 agent”冲突，导致只存在于 `agent.json`、尚未部署的 agent 无法出现在下方配置面板。

## Fix
- 去掉固定可见 agent 过滤。
- 新增 `synthesizeAgentsFromConfigs()`：将 `runtime-view.agents`、`catalog.agents`、`runtime-view.configs` 合并成统一的动态 agent 列表。
- 对仅存在于 `runtime-view.configs` 的 agent，合成一个 `source=agent-json`、`status=idle` 的静态卡片，保证面板可以选中并进入配置抽屉。

## Validation
- `cd ui && pnpm vitest run src/hooks/useAgentRuntimePanel.test.ts src/components/BottomPanel/BottomPanel.test.tsx`
- `cd ui && pnpm exec tsc -b --pretty false`

## Notes
- orchestration profile 的 `visible` 仍可用于编排/展示层，但不再作为底部配置面板的过滤条件。
