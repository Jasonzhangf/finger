# 2026-03-07 agent enable toggle and quota copy

## Goal
修复 agent 配置 drawer 中 `enabled` 无法真正关闭的问题，并在下方 Agent 面板提供直接启用/禁用入口，同时把 quota 文案改成用户可理解的描述。

## Root Cause
- `enabled` 之前没有作为 `agent.json` 顶层字段解析/持久化。
- runtime 里虽然有 `runtime.enabled` patch，但 reload 后还是按已加载配置重新推导，导致 drawer 重开后状态被打回。
- drawer 的 draft 会在同 agent 的刷新时重新初始化，覆盖掉用户刚切换的 enabled。

## Fix
- `src/runtime/agent-json-config.ts`
  - 支持顶层 `enabled` schema / parse / apply 到 runtime config。
- `src/server/routes/agent-configs.ts`
  - configs 列表接口返回 `enabled`。
- `ui/src/components/WorkflowContainer/WorkflowContainer.tsx`
  - 新增 `handleToggleAgentEnabled()`，通过 `GET/PUT /api/v1/agents/configs/:agentId` 持久化开关。
- `ui/src/components/BottomPanel/BottomPanel.tsx`
  - 增加卡片级 `启用/禁用` 按钮。
- `ui/src/components/AgentConfigDrawer/AgentConfigDrawer.tsx`
  - 同 agent 刷新时保留 draft 的 enabled 变更，不再强制回弹。
  - `Workflow Quota` 改名为“按工作流覆盖配额”，增加格式说明。

## Validation
- `cd ui && pnpm vitest run src/components/AgentConfigDrawer/AgentConfigDrawer.test.tsx src/components/BottomPanel/BottomPanel.test.tsx`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `cd ui && pnpm exec tsc -b --pretty false`

## Follow-up
- 底部 agent 卡片现在拆分为“状态徽标 + 动作按钮”：`已启用/已禁用` 用颜色表达状态，`启用/禁用` 只表达动作。
- Drawer 的“运行配置（部署）/应用并部署”已改为“运行配置/应用并保存”，并改为直接保存到 `agent.json`，不再调用 deploy endpoint。
- `WorkflowContainer` 中 drawer 保存逻辑改为 `GET + PUT /api/v1/agents/configs/:agentId`，保存后刷新 panel，保证行为与文案一致。
- 额外修复：`AgentConfigDrawer` 组件测试默认会在 mount 时请求 `GET /configs/:agentId` 与 `GET /configs/:agentId/prompts`。若个别用例未 mock `fetch`，happy-dom/node 会打印 `socket hang up` 噪音。已为该测试文件补上默认 fetch mock，并在基础渲染用例中等待初始异步请求完成，测试输出现已干净。
- 新发现并修复：底部启用/禁用点击后“看起来没用”的根因在 `src/blocks/agent-runtime-block/index.ts`。runtime view 之前只把 `enabled` 当作 `runtime.enabled`/缓存 profile 读取，没有把 `agent.json` 顶层 `enabled` 作为真源，且会缓存从 loaded config 推导出的完整 profile。现在改为每次读取时从 loaded config 重新构建 base profile，再叠加运行期 override，避免 reload 后旧缓存把新配置覆盖回去。
