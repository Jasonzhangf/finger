# Cross-Agent 更新消费框架（可配置、去耦合）设计草案 v1

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

## 4. 统一模型：Canonical Execution Update Event（唯一消费协议）

新增统一事件结构（建议命名：`ExecutionUpdateEvent`）：

```ts
interface ExecutionUpdateEvent {
  id: string;
  ts: string;                 // ISO8601
  seq: number;                // 同一 flow 内单调递增序号（用于顺序与去重）
  flowId: string;             // 推荐=taskId 或 dispatchId（全链路主键）
  traceId: string;            // 跨 agent 链路 ID
  taskId?: string;            // 业务任务 ID
  sessionId: string;
  sourceAgentId: string;
  targetAgentId?: string;
  sourceType: 'user' | 'heartbeat' | 'mailbox' | 'cron' | 'system-inject';
  deliveryKey?: string;       // channel::groupId::userId（可选，供路由层快速定位）
  parentEventId?: string;     // 因果链（可选）

  phase: 'dispatch' | 'execution' | 'delivery' | 'review' | 'completion';
  kind: 'reasoning' | 'tool' | 'status' | 'decision' | 'artifact' | 'error';
  level: 'debug' | 'info' | 'milestone' | 'critical';
  finishReason?: 'stop' | 'length' | 'tool_call' | 'error' | string;

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
- `flowId + seq` 必须稳定可复现（同一事件重放不能变）。
- `sourceType` 必填，用于“用户交互任务 vs 定时任务”策略分流。

### 4.1 flowId / seq 生成规则（强制）

为避免实现歧义，明确如下：

1. `flowId` 由 **dispatch 入口** 统一生成（优先沿用 `taskId`，否则使用 `dispatchId`）。
2. `seq` 采用 **per-flow** 计数器（不是 per-session），从 `1` 开始递增。
3. Project/Reviewer 继承父 flow，不得新开 flow（除非明确创建子任务 flow）。
4. 重启恢复时从 Correlation Store 的 `latestSeq` 续号，禁止回退或复用旧序号。
5. 若检测到倒序/重复，事件进入 `kind=error, level=critical` 并阻断外发（防污染）。

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
- 支持重启恢复（持久化到 `~/.finger/runtime/update-correlation/*.jsonl`）。
- `flowId -> { traceId, taskId, currentStage, latestSeq }` 作为恢复真源。

### 5.3 Policy Engine（配置驱动，单一决策入口）

输入：`ExecutionUpdateEvent` + `update-stream.json`  
输出：`deliver | drop | aggregate | throttle`

决策维度：

- agent 角色（system/project/reviewer）
- phase（dispatch/execution/review/...）
- kind（tool/reasoning/...）
- channel（qqbot/weixin/webui）
- 粒度（off/milestone/tool/reasoning/full）
- sourceType（user/heartbeat/mailbox/cron/system-inject）

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
- idempotency-key
- ordered-delivery（同 flow 按 seq 保序）

### 5.6 Canonical Event 持久化与保留策略

建议新增 Canonical Event 落盘目录：

- `~/.finger/runtime/events/canonical/*.jsonl`

保留策略（默认）：

1. 按时间：保留最近 7 天。
2. 按大小：单文件上限 64MB，超限滚动新文件。
3. 清理任务：每日低峰执行，保留最近 N 个滚动文件（默认 20）。
4. 清理过程必须产生日志与统计（删除数量、保留数量、最后文件时间戳）。

---

## 6. 配置模型（建议）

文件：`~/.finger/config/update-stream.json`

```json
{
  "enabled": true,
  "defaultGranularity": "milestone",
  "sourceTypePolicy": {
    "user": { "mode": "all" },
    "heartbeat": { "mode": "result_only" },
    "mailbox": { "mode": "result_only" },
    "cron": { "mode": "result_only" },
    "system-inject": { "mode": "result_only" }
  },
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
  "delivery": {
    "dedupWindowMs": 12000,
    "retry": {
      "maxAttempts": 10,
      "baseDelayMs": 1000,
      "maxDelayMs": 60000,
      "strategy": "exponential"
    }
  },
  "failClosedReview": true
}
```

### 6.1 配置合并优先级（Single Source of Truth）

为避免与现有配置冲突，统一规定：

1. **session 临时策略**（`session.context.progressDelivery*`，本轮注入）  
2. **update-stream.json（按 flow/sourceType/role/channel）**  
3. **channels.json pushSettings（通道默认）**  
4. **系统默认值**

规则：

- 高优先级可“关掉”低优先级项；低优先级不能覆盖高优先级显式关闭。
- 所有最终决策都由 PolicyEngine 输出，其他模块不再直接判定是否推送。

### 6.2 PolicyEngine 冲突判定矩阵（示例）

| 场景 | role规则 | channel规则 | sourceType规则 | 最终决策 |
|---|---|---|---|---|
| A | 允许（project/tool） | 禁止（qqbot tool=false） | 允许（user=all） | **drop** |
| B | 允许（review/decision） | 允许（weixin milestone） | 限制（cron=result_only） | **aggregate/result_only** |
| C | 禁止（system 不发 reasoning） | 允许 | 允许 | **drop** |
| D | 允许 | 允许 | 允许 | **deliver** |

说明：冲突时按“先上层策略收敛，再下发渠道能力”的顺序判定；任一显式禁止即可终止外发。

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
- 该阻断行为必须发出 `kind=error, phase=review, level=critical` 的 Canonical Event（可审计）。

### 7.3 运维兜底（管理员人工放行）

为防止生产事故中 route 长时间损坏导致完全阻塞，提供受控兜底：

1. 默认关闭：`reviewAdminBypass.enabled=false`
2. 仅管理员可触发，且必须附带原因与工单号。
3. 放行事件必须写入审计日志，并发出 `kind=decision, level=critical` 事件。
4. 放行仅对单一 `flowId` 生效，自动过期（默认 10 分钟）。
5. UI/CLI 必须显式标注“人工放行”，不可静默。

---

## 8. 多 Agent 同 Session 状态机约束（关键）

为避免 system/project/reviewer 在同 session 下互相污染状态，强制：

1. 运行状态粒度是 **(sessionId, agentId)**，不是 session 级。
2. 无 `agentId` 的事件不得直接更新任一 agent 状态，需：
   - 通过关联表推断唯一 agent；或
   - 仅作为 session 元数据事件，不影响 agent 运行态。
3. 任一 agent 收到 tool/model/reasoning 事件时，若当前非 completed/failed，应立即恢复为 running。
4. completed/failed 只能由明确结束事件触发，不能被无关事件回写。

### 8.1 脱敏与敏感信息过滤（强制）

对 artifacts / logs / reasoning 的外发统一执行脱敏：

1. 凭证类：token、apikey、cookie、authorization 头统一掩码。
2. 路径类：本地绝对路径按策略裁剪（仅保留项目相对路径）。
3. 个人信息：手机号、邮箱、身份证等按规则脱敏。
4. 二进制/大文本：仅外发摘要（长度上限 + hash），正文按需查看。
5. 任一脱敏失败按 fail-closed 处理：阻断外发并记录 `critical` 审计事件。

---

## 9. 与现有模块的迁移策略

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

## 10. 验证与回归建议

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
5. sourceType 分流：heartbeat/cron 默认仅结果推送
6. 同 session 多 agent 并行执行不互相覆盖运行状态
7. 幂等：相同 `flowId+seq` 重放不重复下发

---

## 11. 当前建议

优先落地两件事：

1. `ExecutionUpdateEvent` + `PolicyEngine`（不改业务语义）
2. review pipeline 事件统一化（PASS/REJECT 变成一等决策事件）

这样可以先把“可配置消费框架”打稳，再逐步收敛旧逻辑。
