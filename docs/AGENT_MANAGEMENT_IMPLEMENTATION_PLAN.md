# Agent 管理面板与 Runtime 联动实施计划

## 1. 目标

本计划用于落地以下三类能力，并明确先后顺序与验证关卡：

1. Agent 基础能力：支持 quota 与多实例资源池。
2. UI 管理能力：底部可展示、可配置，左侧抽屉可编辑。
3. Canvas 联动能力：按既有设计文档同步展示编排者与动态 runtime。

## 2. 设计基线与约束

本计划基于以下文档，不重复定义其底层协议：

- `docs/AGENT_RUNTIME_AND_SESSION_LIFECYCLE.md`
- `docs/design/task-flow-canvas-v12.md`
- `docs/TASK_LIFECYCLE.md`

已确认的产品规则：

1. 右侧默认上下文为 orchestrator。
2. 切到 runtime 后允许直接发消息。
3. runtime 结束后自动回 orchestrator。
4. 已结束 runtime 支持查看历史。
5. quota 支持 project 与 workflow 两级配置。
6. 点击底部 agent 卡片后，在左侧抽屉编辑配置。

## 3. 核心模型与契约

## 3.1 统一模型

- `AgentConfig`: agent 的静态定义（能力、默认配额、启停）。
- `QuotaPolicy`: `project` 与 `workflow` 的覆盖策略。
- `RuntimeInstance`: 动态运行实例（runtimeId、sessionId、状态、摘要、队列位次）。
- `SessionBinding`: `runtimeId -> sessionId` 映射与当前右侧上下文。

配额解析规则：

`effectiveQuota = workflowQuota ?? projectQuota ?? defaultQuota`

## 3.2 最小事件集合

以下事件是 UI、右侧会话与 Canvas 的唯一同步来源：

1. `runtime_spawned`
2. `runtime_bound_session`
3. `runtime_status_changed`
4. `runtime_queue_changed`
5. `runtime_summary_updated`
6. `runtime_finished`

要求：事件 append-only，字段新增向后兼容，不复用旧字段语义。

## 4. 分阶段实施顺序

## Phase 0 - 契约冻结（必须先做）

目标：冻结模型字段与事件定义，避免后续 UI 与 Canvas 返工。

交付：

- 数据结构定义清单。
- 事件字段表与状态映射表。
- 右侧会话上下文状态机说明。

DoD：

- UI/Canvas/调度三方对事件名与字段完全一致。
- 串行与并发模式都使用同一套事件，不分叉。

Gate-0 验证：

- 评审清单通过：字段、状态、边界条件（结束回退、历史查看）均无冲突。

## Phase 1 - Agent 基础能力（先串行验证）

目标：先实现可用、可验证的 quota/多实例基础，但运行策略强制串行。

实现重点：

- 资源池支持多实例容量建模。
- 调度按 `effectiveQuota` 控制并发上限。
- 验证阶段强制 `effectiveQuota = 1`（串行模式）。
- 完整队列状态（queued/running/finished）与位次管理。

DoD：

- 同类任务严格串行执行，无并发漂移。
- 队列位次与实际执行顺序一致。
- runtime 生命周期状态完整闭合。

Gate-1 验证：

- 单元：quota 解析、状态机、排队出队。
- 集成：资源池 + runtime 生命周期 + 会话绑定。
- 压测：连续提交 N 个同类任务，执行顺序稳定。

## Phase 2 - UI 管理面板与配置能力

目标：底部可观测、可配置；左抽屉可编辑 project/workflow quota。

实现重点：

- 卡片展示：Running、Queued、Quota、最近动态、历史入口。
- 交互分离：点击 runtime 切右侧上下文；点击卡片空白开左抽屉。
- 抽屉保存后即时回显到卡片和状态流。

DoD：

- 用户可明确看到 quota 来源（workflow/project/default）。
- 配置保存后刷新不丢失。
- 变更不会破坏串行验证模式。

Gate-2 验证：

- UI 测试：卡片渲染、抽屉编辑、保存回显。
- 联动测试：修改 quota 后状态计数正确更新。

## Phase 3 - 右侧会话联动

目标：完成 orchestrator 与 runtime 上下文切换闭环。

实现重点：

- 默认上下文固定 orchestrator。
- runtime 点击切换到对应 session，并允许发消息。
- runtime 结束时自动回 orchestrator。
- 历史查看入口独立，不抢当前主上下文。

DoD：

- 用户在 runtime 上下文发出的消息进入该 runtime 会话。
- runtime 结束回退行为稳定，不出现死上下文。

Gate-3 验证：

- 端到端：切换 runtime -> 发消息 -> runtime 结束 -> 自动回编排者。
- 回归：历史查看不影响当前输入目标。

## Phase 4 - Canvas 同步更新（按 v12）

目标：Canvas 与底部面板、右侧会话保持同源一致。

实现重点：

- 节点模型：orchestrator 主节点 + runtime 动态节点。
- 关系：`spawned_by`，可带 taskId/workflowId。
- 节点状态映射与摘要实时刷新。
- 点击运行中节点切会话，点击已结束节点看历史。

DoD：

- 节点数量、状态、摘要与事件流一致。
- Canvas 操作可驱动右侧会话切换。

Gate-4 验证：

- 事件回放验证：按事件序列重建图状态一致。
- 交互验证：Canvas 点击路径和底部路径行为一致。

## Phase 5 - 并发放开（灰度）

目标：从串行迁移到并发，验证吞吐提升且不破坏一致性。

实现重点：

- 将 `effectiveQuota` 从 1 放开到 N。
- 验证多 runtime 同时运行时的会话路由与状态一致性。
- 补齐异常恢复（失败、取消、中断）。

DoD：

- 并发数不超过配额上限。
- 无重复调度、无幽灵 runtime、无会话错投。

Gate-5 验证：

- 并发场景 E2E：N>1 同类任务并行 + 结束回退 + 历史可查。
- 稳定性：乱序事件、延迟事件下 UI 可收敛到正确状态。

## 5. 验证执行顺序（必须按序）

1. 单元层：quota 解析、队列逻辑、状态机。
2. 集成层：资源池 + runtime + sessionBinding。
3. UI 层：底部卡片、左抽屉、配置生效回显。
4. 联动层：右侧会话切换、自动回退、历史入口。
5. Canvas 层：节点状态、摘要、关系、点击联动。
6. 端到端层：先串行主链路，再并发链路。

## 6. 风险与缓解

1. 事件契约反复变动导致三端返工。
   - 缓解：Phase 0 先冻结契约，后续仅增量字段。
2. 并发提前开放导致问题定位困难。
   - 缓解：强制先通过串行 Gate，再放开并发。
3. UI 本地状态与后端真状态漂移。
   - 缓解：UI 只消费事件，不做独立状态真源。
4. runtime 结束后的上下文回退不一致。
   - 缓解：统一由 `runtime_finished` 事件触发回退。

## 7. bd 任务管理方案

## 7.1 Issue 结构

- 1 个 epic：管理该能力全量交付。
- 6 个 task：对应 Phase 0~5。
- 任务依赖：严格串联，确保先后顺序不可跳过。

## 7.2 状态推进规则

1. 每个 phase 启动前，前一 phase 必须 `closed`。
2. 若 Gate 未通过，当前任务保持 `in_progress`，并在 comment 记录失败点。
3. Gate 通过后 `close` 当前任务，再开启后续任务。

## 7.3 建议标签

- `agent-runtime`
- `quota`
- `ui-panel`
- `session-link`
- `canvas`
- `serial-first`
- `concurrency-rollout`

## 8. 完成标准（项目级）

全部满足才算完成：

1. 底部、右侧、Canvas 三者状态一致且可互相联动。
2. 串行模式稳定可回归验证。
3. 并发模式灰度可控，可随时回退到串行。
4. 关键链路有可重复验证脚本或测试用例。

