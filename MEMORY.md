
## 2026-03-06 Collaboration Preferences
- 当用户要求“提交所有代码”时，提交仓库内代码/文档/测试/脚本变更，但排除构建物、日志、临时文件、生成物、隐私文件与本地工具状态目录。
- 与 agent prompt 相关的覆盖链路采用：默认读取仓库系统 prompt，用户保存后写入 `~/.finger/runtime/agents/<agent-id>/prompts/...`，并以下次任务开始时优先加载该覆盖。

## 2026-03-07 Dispatch Handoff
- Structured output 返回需要容错：先本地修 JSON，再按 schema 校验；失败时按可配置重试次数发起字段路径级重试提示，错误必须明确到 JSON path。
- 子 agent 派发返回必须只回灌轻量 `summary/status/keyFiles/evidence/childSessionId`，不能把 `metadata.api_history`、原始 transcript 或完整工具历史直接送回主编排器下一轮输入。
- `agent.dispatch` 的任务下发应带明确 goal / acceptance / response contract，优先启用 structured output schema，保证 executor 输出 JSON handoff。

## 2026-03-07 Agent Prompt Editing UI
- Agent 配置抽屉中的提示词编辑支持两层入口：抽屉内快速 textarea 编辑，以及全屏模态框编辑/预览 Markdown。
- 提示词默认读取系统 prompt；用户保存后写入 `~/.finger/runtime/agents/<agent-id>/prompts/...` 覆盖文件，并在下一次任务开始时生效。
- 全屏提示词模态框需要展示读取路径、写入路径、role/source 元信息；Markdown 预览至少支持标题、段落、引用、列表、代码块、行内 code、粗体、斜体。

## 2026-03-07 Bottom Panel Agent Source
- 下方 Agent 配置面板中的静态 agent 列表必须是动态聚合结果，不能只显示默认固定 agent。
- 真正来源是三者合并：`runtime-view.agents`、`catalog.agents`、`runtime-view.configs`；即使某个 agent 还未部署、只存在于 `agent.json`，也要在面板里出现并可配置。
- orchestration profile 的 `visible` 不应裁掉配置面板里的 agent 候选；它只影响编排展示，不应影响配置真源。

## 2026-03-07 Agent Enable Truth Source
- agent 的启用状态要持久化到 `agent.json` 顶层 `enabled`，不能只停留在 runtime patch，否则 drawer 重开或 reload 后会被重新覆盖成 `true`。
- Drawer 中的 `enabled` 编辑是配置编辑，不应因为同一个 agent 的刷新而被 `pickDefaultDraft()` 重置。
- 下方 Agent 卡片需要有直接 `启用/禁用` 操作，且该操作应走 `GET /api/v1/agents/configs/:agentId` + `PUT /api/v1/agents/configs/:agentId` 持久化，再刷新面板。
- `Workflow Quota` 文案对用户不直观，应该改成“按工作流覆盖配额”，并解释格式 `workflowId=配额`。

## 2026-03-07 Agent Config Save Semantics
- 底部 agent 卡片的启用态展示必须把“当前状态”和“可执行动作”分开：状态徽标显示 `已启用/已禁用`，动作按钮显示 `禁用/启用`，避免绿色按钮文字与当前状态混淆。
- Agent 配置抽屉里的运行配置区域本质是配置编辑，不是 runtime deploy；UI 文案必须使用“应用并保存/保存中”，并明确说明“保存到 agent.json，下一次任务开始生效，不会立即部署实例”。
- 抽屉保存运行配置时必须直接写入 `/api/v1/agents/configs/:agentId`，不能再走 `/api/v1/agents/deploy`，否则禁用态下会出现“还能部署”的错误语义和错误行为。

## 2026-03-07 Agent Enabled Runtime Truth Source
- `runtime-view.agents[].enabled` 与 `runtime-view.configs[].enabled` 必须最终反映 `agent.json` 顶层 `enabled`，不能只读取 `runtime.enabled`。
- `AgentRuntimeBlock` 里的 `runtimeConfigByAgent` 不能缓存“从 loaded config 推导出的完整 profile”，否则 agent.json reload 后旧缓存会把新配置盖回去。
- 正确策略是：每次读取时先重新计算 loaded-config base profile，再叠加仅用于运行期 patch 的 override profile。
