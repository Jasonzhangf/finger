# Agent Runtime 与会话生命周期设计

## 1. 目标与范围

本文档定义 Agent 管理与会话联动的统一设计，覆盖 `orchestrator`、动态 `runtime`、底部 Agent 管理面板、右侧会话、中心 Canvas。

目标：

1. 右侧默认保持“人 <-> 编排者”主会话。
2. 底部展示真实 runtime，并可切换到 runtime 会话观察与交互。
3. Agent 支持资源池配额与队列，先串行验证，再放开并发。
4. Canvas 同步展示 orchestrator 与动态 runtime 的关系、状态、摘要。

非目标：

- 本文不定义具体视觉样式，不涉及像素级 UI 规范。
- 本文不替代 tool 协议定义，仅定义运行时与 UI 事件契约。

## 2. 核心决策（已确认）

1. 右侧切到 runtime 后，用户可直接向 runtime 发消息。
2. runtime 结束后，右侧自动回到 orchestrator。
3. 已结束 runtime 支持点开历史查看。
4. `quota` 同时支持 project 级与 workflow 级配置。
5. 底部点 Agent 卡片后，在左侧抽屉配置。
6. 中间 Canvas 必须展示 orchestrator 与 runtime 的动态关系与摘要。

## 3. 分层与职责

### 3.1 Kernel（单任务回合执行器）

- 输入：`user_turn(items, options)`。
- 负责模型-工具回环闭合：`function_call -> tool execute -> function_call_output -> next turn`。
- 输出：`task_complete`（含 `last_agent_message` 与 `metadata_json`）。

约束：Kernel 对外是一次 `user_turn`，内部允许多轮推理与工具调用。

### 3.2 Runner（会话驱动器）

- 维护会话生命周期（同一 `sessionId` 复用同一运行上下文）。
- 处理运行中输入（pending input）并注入当前 task。
- 将 kernel 事件转换为 UI 可消费事件。

### 3.3 Orchestrator（编排控制器）

- 选择 Agent 并分派任务，触发 runtime 创建与回收。
- 管理 `runtimeId <-> sessionId` 绑定。
- 管理队列与配额策略。

### 3.4 UI（观察与交互层）

- 底部 Agent 面板：状态总览 + runtime 列表 + 入口交互。
- 右侧会话：默认 orchestrator，可切 runtime，会话可发送消息。
- 中间 Canvas：关系图与动态摘要。
- UI 不持有真状态，真状态来自 daemon/runner 事件流。

## 4. 数据模型

### 4.1 AgentConfig（静态配置）

```ts
interface AgentConfig {
  agentType: string;
  displayName: string;
  capabilities: string[];
  defaultQuota: number;
  enabled: boolean;
}
```

### 4.2 QuotaPolicy（双层配额）

```ts
interface QuotaPolicy {
  project?: number;
  workflow?: Record<string, number>;
}
```

有效并发计算：

`effectiveQuota = workflowQuota ?? projectQuota ?? defaultQuota`

### 4.3 RuntimeInstance（动态实例）

```ts
interface RuntimeInstance {
  runtimeId: string;
  agentType: string;
  sessionId: string;
  workflowId?: string;
  status: 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'interrupted';
  queuePosition?: number;
  summary?: string;
  startedAt: number;
  endedAt?: number;
}
```

### 4.4 SessionBinding（会话绑定）

```ts
interface SessionBinding {
  selectedContext: 'orchestrator' | string; // runtimeId
  orchestratorSessionId: string;
  runtimeSessionMap: Record<string, string>; // runtimeId -> sessionId
}
```

## 5. 交互状态机

### 5.1 右侧会话上下文

默认状态：`selectedContext = orchestrator`

切换规则：

1. 点击底部 runtime 或 Canvas runtime 节点 -> `selectedContext = runtimeId`。
2. 该 runtime 结束（`completed/failed/interrupted`）且当前正在查看它 -> 自动切回 `orchestrator`。
3. 用户点击“查看历史” -> 打开历史详情，不改变默认主上下文规则。

### 5.2 发送消息规则

1. 当前上下文是 orchestrator：消息发送至编排会话。
2. 当前上下文是 runtime：消息发送至该 runtime 会话。
3. runtime 结束后输入框恢复面向 orchestrator。

### 5.3 底部面板与左抽屉

1. 点 Agent 卡片空白区 -> 打开左抽屉配置。
2. 点 runtime 条目/chip -> 切右侧会话上下文。
3. 抽屉保存后，卡片计数与 Canvas 节点状态立即刷新。

## 6. 底部 Agent 面板设计

每个 Agent 卡片至少展示：

- `Running`：运行中实例数。
- `Queued`：排队实例数。
- `Quota`：当前生效配额（显示来源：workflow/project/default）。
- `Last Event`：最近动态摘要（例：tool call success / tool error）。
- `History`：已完成 runtime 的历史入口。

左抽屉配置分区：

1. 基础配置（启用开关、能力、默认值）。
2. Project Quota。
3. Workflow Quota（按 workflow 维度覆写）。
4. 运行策略（串行验证模式/并发模式）。

## 7. Canvas 联动设计

### 7.1 图模型

- 主节点：`orchestrator`（固定存在）。
- 子节点：`runtime`（动态创建/销毁，历史可折叠）。
- 边：`spawned_by`，可附 `taskId/workflowId`。

### 7.2 节点状态映射

- `queued`
- `running`
- `waiting_input`
- `completed`
- `failed`
- `interrupted`

### 7.3 节点信息与交互

- 节点摘要：展示 runtime 最近可读动态。
- 动态更新：随事件流实时刷新摘要与状态。
- 点击运行中节点：切到右侧 runtime 会话。
- 点击已结束节点：打开历史详情。

## 8. 事件契约（最小集合）

为保证面板、会话、Canvas 一致，至少定义以下事件：

1. `runtime_spawned`
   - 字段：`runtimeId, agentType, sessionId, workflowId, startedAt`
2. `runtime_bound_session`
   - 字段：`runtimeId, sessionId`
3. `runtime_status_changed`
   - 字段：`runtimeId, status, timestamp`
4. `runtime_queue_changed`
   - 字段：`agentType, runtimeId, queuePosition, queuedCount, timestamp`
5. `runtime_summary_updated`
   - 字段：`runtimeId, summary, sourceEvent, timestamp`
6. `runtime_finished`
   - 字段：`runtimeId, finalStatus, endedAt, reason`

兼容建议：事件采用 append-only，新增字段向后兼容，不复用字段语义。

## 9. 串行到并发的发布策略

### 9.1 Phase 1（串行验证，必须先做）

- 强制目标 Agent `effectiveQuota = 1`。
- 超出请求全部进入队列。
- 完成以下验收：
  - 右侧默认 orchestrator。
  - 可切 runtime 并发送消息。
  - runtime 结束自动回 orchestrator。
  - Canvas 正确展示关系与状态流转。

### 9.2 Phase 2（规则完善）

- 双层 quota（project/workflow）可配置并正确生效。
- 队列可视化完整（位置、计数、状态变化）。
- 历史查看入口稳定可用。

### 9.3 Phase 3（放开并发）

- 打开 `effectiveQuota > 1`。
- 同时多 runtime 并发执行并稳定同步到会话与 Canvas。
- 验证多实例输入路由、回退策略、异常恢复。

## 10. 验收清单

1. 启动后右侧默认显示 orchestrator 会话。
2. 任意 runtime 可从底部或 Canvas 切入，并可直接发送消息。
3. runtime 结束时，若当前在该 runtime，上下文自动回 orchestrator。
4. 已结束 runtime 可从 Agent 卡片或 Canvas 查看历史。
5. `effectiveQuota` 按 `workflow > project > default` 生效。
6. 串行模式下同类 runtime 按队列执行，不出现并发漂移。
7. 事件缺失或乱序时，UI 可恢复一致状态（以最新状态事件为准）。
