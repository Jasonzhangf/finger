# Cross-Agent 更新消费框架（可配置、去耦合）设计草案 v0

## 1. 背景

当前 System Agent → Project Agent → Reviewer Agent 的执行链路中，推理/工具/派发/审查等更新信息由多个模块并行消费并下发：

- `event-forwarding`
- `progress-monitor`
- `agent-status-subscriber`

这些模块同时承担了“事件解析 + 聚合 + 文案格式化 + 渠道路由”的职责，导致：

1. 重复消费：同一事件被多处处理，输出口径不一致。
2. 强耦合：业务阶段（dispatch/review）和渠道输出逻辑混杂。
3. 难配置：无法用一份统一配置定义“哪个阶段、哪个agent、哪个渠道、什么颗粒度推送”。
4. 可观测性弱：跨 agent 的 trace/task 关联不统一，排查困难。

---

## 2. 目标

建设一个跨 agent、去耦合、可配置的更新消费框架，实现：

1. **统一事件真源**：所有执行更新先归一为 Canonical Event。
2. **统一策略中心**：由配置控制推送粒度、频率、渠道、角色。
3. **统一路由与格式化**：阶段无关、渠道可插拔。
4. **跨 agent 全链路关联**：同一 task/trace 在 system/project/reviewer 间可追踪。
5. **Fail-Closed 审核链**：review-required 流程下不能绕过 reviewer。

---

## 3. 非目标（本期不做）

1. 不重写 kernel/runtime event 生产逻辑。
2. 不改变工具调用语义，仅重构消费与分发层。
3. 不在本期做复杂 UI 可视化编辑器，仅先支持 JSON 配置。

---

## 4. 统一模型：Canonical Execution Update Event

新增统一事件结构（建议命名：`ExecutionUpdateEvent`）：

```ts
interface ExecutionUpdateEvent {
  id: string;
  ts: string;                 // ISO8601
  traceId: string;            // 跨 agent 链路 ID
  taskId?: string;            // 业务任务 ID
  sessionId: string;
  sourceAgentId: string;
  targetAgentId?: string;

  phase: 'dispatch' | 'execution' | 'delivery' | 'review' | 'completion';
  kind: 'reasoning' | 'tool' | 'status' | 'decision' | 'artifact' | 'error';
  level: 'debug' | 'info' | 'milestone' | 'critical';

  payload: Record<string, unknown>;
  artifacts?: Array<{
    type: 'screenshot' | 'log' | 'file' | 'report';
    path?: string;
    digest?: string;
    summary?: string;
  }>;
}
```

约束：

- 任何对外推送必须来源于 `ExecutionUpdateEvent`。
- 上游原生事件（tool_call/model_round 等）通过 Adapter 转换到该模型。

---

## 5. 框架分层

### 5.1 Event Adapter Layer

输入：`runtime/event-bus` 原生事件。  
输出：`ExecutionUpdateEvent`。

适配器示例：

- `ToolEventAdapter`
- `ReasoningEventAdapter`
- `DispatchLifecycleAdapter`
- `ReviewDecisionAdapter`

### 5.2 Correlation Layer

职责：维护 `traceId/taskId/sessionId/routeId` 映射。

关键能力：

- System 派发时创建 `traceId`。
- Project/Reviewer 后续事件自动继承同一 `traceId`。
- 支持重启恢复（持久化到 `~/.finger/runtime/schedules/*.jsonl`）。

### 5.3 Policy Engine（配置驱动）

输入：`ExecutionUpdateEvent` + `update-stream.json`  
输出：`deliver | drop | aggregate | throttle`

决策维度：

- agent 角色（system/project/reviewer）
- phase（dispatch/execution/review/...）
- kind（tool/reasoning/...）
- channel（qqbot/weixin/webui）
- 粒度（off/milestone/tool/reasoning/full）

### 5.4 Formatter Layer

职责：将统一事件转换为渠道文本/结构体。

- `QQTextFormatter`
- `WeixinTextFormatter`
- `WebUIRichFormatter`

### 5.5 Delivery Adapter Layer

统一对接发送通道，负责：

- dedup
- rate-limit
- retry
- fallback route

---

## 6. 配置模型（建议）

文件：`~/.finger/config/update-stream.json`

```json
{
  "enabled": true,
  "defaultGranularity": "milestone",
  "channels": {
    "qqbot": {
      "enabled": true,
      "granularity": "tool",
      "reasoning": true,
      "throttleMs": 1500
    },
    "openclaw-weixin": {
      "enabled": true,
      "granularity": "milestone",
      "reasoning": false,
      "throttleMs": 2500
    },
    "webui": {
      "enabled": true,
      "granularity": "full",
      "reasoning": true,
      "throttleMs": 0
    }
  },
  "roles": {
    "system": {
      "phases": ["dispatch", "completion"],
      "kinds": ["status", "decision", "error"]
    },
    "project": {
      "phases": ["execution", "delivery"],
      "kinds": ["tool", "reasoning", "artifact", "error"]
    },
    "reviewer": {
      "phases": ["review"],
      "kinds": ["decision", "artifact", "error"]
    }
  },
  "failClosedReview": true
}
```

---

## 7. 审查链（Review Pipeline）规则固化

### 7.1 标准流程

1. System 派发（`review_required=true`）
   - 自动拉起 reviewer runtime
   - 注册 review route
   - 下发验收标准

2. Project 交付
   - `report-task-completion` 默认先路由 reviewer

3. Reviewer 决策
   - PASS：自动上报 system 完成
   - REJECT：自动回派 project，附拒绝意见与修复标准

### 7.2 Fail-Closed

- 若 task 标记 review-required，但 route 丢失：
  - **拒绝直接上报 system**
  - 记录错误事件 + 要求恢复 route 后重试

---

## 8. 与现有模块的迁移策略

### 阶段 A（兼容）

- 保留现有 `event-forwarding/progress-monitor/subscriber`
- 新增 `ExecutionUpdateEvent` 镜像总线（shadow mode）
- 对比旧新输出一致性

### 阶段 B（切流）

- `agent-status-subscriber` 改为只消费 Canonical Event
- `progress-monitor` 仅做聚合，不直连渠道

### 阶段 C（收敛）

- 删除旧的重复格式化与重复下发逻辑
- 统一策略/配置入口

---

## 9. 验证与回归建议

### 单元测试

1. EventAdapter：原生事件 -> Canonical Event 字段齐全
2. PolicyEngine：不同配置下的决策正确
3. Formatter：各渠道输出符合约定
4. Review Fail-Closed：route 丢失时阻断上报

### 集成测试

1. system→project→reviewer（PASS）
2. system→project→reviewer（REJECT→project重试）
3. daemon 重启后 route 恢复
4. 三渠道粒度配置生效

---

## 10. 当前建议

优先落地两件事：

1. `ExecutionUpdateEvent` + `PolicyEngine`（不改业务语义）
2. review pipeline 事件统一化（PASS/REJECT 变成一等决策事件）

这样可以先把“可配置消费框架”打稳，再逐步收敛旧逻辑。

