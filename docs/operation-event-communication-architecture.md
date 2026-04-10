---
title: Operation/Event 通信架构设计
description: Finger 多 Agent 通信层改造唯一真源文档
tags: [architecture, communication, operation, event, multi-agent]
created: 2026-04-10
updated: 2026-04-10
status: approved
---

# Operation/Event 通信架构设计

## 背景

当前 Finger 多 Agent 通信存在以下问题：
1. **通信语义混乱**：dispatch payload 里请求、状态、结果混在一起
2. **进度不稳定**：没有统一的事件广播机制，前端和观察模块难以可靠订阅
3. **难以追溯**：session 缺少来源标签，无法区分 cli/web/heartbeat/subagent
4. **取消传播弱**：主要靠 timeout，没有 token 传播机制

借鉴 Codex-rs 的 SQ/EQ 模式，将通信分层：
- **Operation（操作层）**：命令式，描述"请执行什么"
- **Event（事件层）**：声明式，描述"发生了什么事实"

## 核心原则

### Operation 层规则
- 必须包含：`from`（发送者）、`to`（接收者）、`intent`（意图）、`payload`（参数）、`opId`（唯一标识）
- 语义：**请执行**
- 不应混入执行结果或状态

### Event 层规则
- 必须包含：`schemaVersion`、`eventId`、`type`、`actor`、`timestamp`、`correlationId`、`causationId`、`ownerWorkerId`、`payload`
- 语义：**事实已发生**
- 订阅方只消费，不反向改写 Operation
- 跨 worker 只读不写（ownership 唯一真源：memoryOwnerWorkerId）

### 准则
> **Operation 负责驱动动作，Event 负责广播事实。**

## 角色模型（Two-Role Architecture）

Finger 只采用**双角色架构**：

1. **System Coordinator** (`/root/finger-system-agent`)
   - 职责：全局协调、heartbeat 管理、session 管理、review 阶段执行
   - Review 是 System 的一个**执行阶段**，不是独立角色

2. **Project Executor** (`/root/finger-project-agent`)
   - 职责：项目级任务执行、上下文构建、dispatch 处理

**无独立 reviewer/orchestrator 角色**。旧代码中 reviewer 相关逻辑全部迁移为 system coordinator 的 review 阶段。

### Ownership 硬约束
- Session ownership 唯一真源：`context.memoryOwnerWorkerId`
- 跨 worker 查看：允许（read-only）
- 跨 worker 写入/执行：禁止（owner-only write/execute）
- Dispatch 必须按 `target_agent + project_path + worker_id` 做确定性会话映射

## Operation Schema

```typescript
interface Operation {
  opId: string;           // 唯一标识，用于追溯（必填）
  from: AgentPath;        // 发送者路径（必填）
  to: AgentPath;          // 接收者路径（必填）
  intent: OperationIntent; // 操作意图枚举（必填）
  payload: unknown;       // 操作参数（必填）
  timestamp: string;      // ISO8601 时间戳（必填）
  blocking?: boolean;     // 是否阻塞式执行（可选）
  timeoutMs?: number;     // 超时时间（可选）
  ownerWorkerId?: string; // 所属 worker（可选，用于 ownership 校验）
}

type OperationIntent =
  | 'dispatch_task'       // 派发任务
  | 'interrupt'           // 中断任务
  | 'query_status'        // 查询状态
  | 'update_config'       // 更新配置
  | 'inter_agent_message' // Agent 间通信
  | 'control_command'     // 控制命令（pause/resume/stop）
  | 'user_input';         // 用户输入

// AgentPath 类型（借鉴 Codex）
type AgentPath = `/root/${string}` | `/root/${string}/${string}`;

// 示例
// "/root" → system coordinator
// "/root/finger-project-agent" → project executor
// "/root/finger-system-agent" → system coordinator（review 阶段也在此路径）
```

## Event Schema（强制字段版）

```typescript
interface Event {
  // 必填字段
  schemaVersion: 'v1';    // Schema 版本（必填，用于兼容性）
  eventId: string;        // 唯一标识（必填）
  type: EventType;        // 事件类型枚举（必填）
  actor: AgentPath;       // 发生者路径（必填）
  timestamp: string;      // ISO8601 时间戳（必填）
  correlationId: string;  // 关联请求 ID（必填，用于请求链路追踪）
  causationId: string;    // 因果 ID（必填，触发本事件的上游事件或操作）
  ownerWorkerId: string;  // 所属 worker（必填，用于 ownership 校验）
  payload: unknown;       // 事件数据（必填）

  // 可选字段
  relatedOpId?: string;   // 关联的 Operation ID（可选但推荐）
  traceId?: string;       // 分布式追踪 ID（可选，用于跨系统追踪）
}

type EventType =
  // Turn 生命周期
  | 'turn_started'
  | 'turn_complete'
  | 'turn_aborted'
  | 'turn_failed'
  // Agent 状态
  | 'agent_status_changed'
  | 'agent_dispatch_queued'
  | 'agent_dispatch_started'
  | 'agent_dispatch_complete'
  | 'agent_dispatch_failed'
  | 'agent_dispatch_partial'  // 新增：证据不足分支
  // 工具执行
  | 'tool_call_begin'
  | 'tool_call_end'
  | 'tool_call_failed'
  // 命令执行
  | 'exec_command_begin'
  | 'exec_command_output'
  | 'exec_command_end'
  // 状态变更
  | 'session_created'
  | 'session_switched'
  | 'session_compacted'
  | 'workflow_started'
  | 'workflow_complete'
  // 进度报告
  | 'progress_update'
  | 'reasoning_delta'
  | 'message_delta'
  // Review 阶段（System Coordinator）
  | 'review_started'
  | 'review_complete'
  | 'review_blocked';
```

### Event Schema 兼容策略

- `v1` → `v2`：新增字段必须向后兼容（可选或有默认值）
- 旧字段不可删除，只能标记 deprecated
- 旧事件写入时缺失字段由系统补默认值（如 `schemaVersion: 'v1'`）

## Dispatch 状态机（含 Partial 分支）

```
Dispatch Lifecycle:

QUEUED → STARTED → [SUCCESS | FAILED | PARTIAL]
                      ↓         ↓         ↓
                   CLOSED    RETRY    EXPLORED_DELIVERY
                      ↓         ↓         ↓
                   [终态]    [重试]    [等待用户决策]
```

### Partial 分支定义
- **触发条件**：执行完成但 `evidence` 或 `explored_paths` 缺失
- **状态**：`agent_dispatch_partial`
- **约束**：不可直接 `closed`，必须：
  1. 补充证据后转 `complete`
  2. 或用户明确决策后转 `closed`（带 `close_reason: 'user_decision'`）

### Closure Gate
- `complete`：有完整 evidence + explored_paths → 可 closed
- `failed`：有明确失败原因 + retry policy → 可 closed 或 retry
- `partial`：无证据 → 必须等待用户决策或补充探索

## Session Source 标签

```typescript
interface SessionSource {
  source: 'cli' | 'webui' | 'vscode' | 'heartbeat' | 'subagent';
  subAgentSource?: {
    type: 'dispatch' | 'review' | 'compact';
    parentThreadId: string;
    depth: number;
  };
  createdAt: string;
  ownerWorkerId: string;  // 新增：创建时的 worker
}
```

## 去重与幂等

### Dedup Key
```
dedupKey = eventType + dispatchId + taskId + attempt + turnId
```

- **eventType**：事件类型
- **dispatchId**：派发 ID
- **taskId**：任务 ID
- **attempt**：尝试次数
- **turnId**：轮次 ID（可选）

### 去重策略
- 相同 dedupKey 的事件在 TTL（默认 24h）内只处理一次
- 重复事件写入 `event_dedup_log` 但不触发 handler
- TTL 过期后自动清理

### 回压策略
- Event queue 满时阻塞 emit（bounded queue）
- Operation queue 满时返回 `rejected: true`（不阻塞）

## 模块设计
## 双通道分工（MessageHub vs EventBus）

Finger 采用双通道架构，分离命令执行与状态通知：

### MessageHub（同步命令通道）

**本质**：RPC 式同步调用

| 维度 | 说明 |
|------|------|
| **语义** | Operation 的传输层，"A 让 B 执行 X" |
| **用法** | `send(message)` → 匹配路由 pattern → 调 handler → 阻塞返回结果 |
| **返回值** | 有（同步/异步结果） |
| **模式** | 1对1，有回调，阻塞/非阻塞可选 |
| **例子** | dispatch 任务 → 查 module → `module.run()` → 返回结果 |

**改造方向**：
1. 从"pattern matching"改为"Operation-aware routing"
2. 路由决策基于 `operation.to`（AgentPath）而非 message.type
3. 校验 `operation.ownerWorkerId` 与目标 module 的 ownership

```typescript
// 改造后的 MessageHub 路由逻辑
class MessageHub {
  async routeOperation(op: Operation): Promise<OperationResult> {
    const targetModule = this.resolveAgent(op.to);
    if (!targetModule) throw new Error(`Unknown agent: ${op.to}`);
    
    // Ownership 校验
    if (!this.validateOwnership(op, targetModule)) {
      return { rejected: true, reason: 'ownership_mismatch' };
    }
    
    // 执行
    return targetModule.handleOperation(op);
  }
}
```

### EventBus（异步通知通道）

**本质**：发布订阅广播

| 维度 | 说明 |
|------|------|
| **语义** | Event 的传输层，"B 完成了 X" |
| **用法** | `emit(event)` → 所有订阅者收到 |
| **返回值** | 无（单向广播） |
| **模式** | 1对多，无回调，纯订阅 |
| **例子** | dispatch 完成通知、progress 报告 |

**约束**：
1. Event 必须有完整的 schema（schemaVersion, eventId, correlationId, causationId, ownerWorkerId）
2. 订阅方只消费，不反向改写 Operation
3. 跨 worker 只读不写（ownership 唯一真源）

### 双通道协作流程

```
Operation 负责驱动动作（MessageHub），Event 负责广播事实（EventBus）。

Agent A ──(1) Operation: dispatch_task ──► MessageHub (同步)
                                          │
                                          ▼
                                    Agent B module.run()
                                          │
                                          ▼
                        (2) 返回结果 ◄─────┘
                                          │
                                          ▼
                        (3) Event: agent_dispatch_complete ──► EventBus (异步广播)
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
              Progress Monitor      Frontend WebSocket     Log/Trace System
```

### 迁移策略

| Phase | MessageHub 状态 | EventBus 状态 |
|-------|-----------------|---------------|
| Phase 1-2 | 保持现有逻辑 | 增强 schema + 去重 |
| Phase 3 | dispatch 接入 OperationRouter | dispatch 状态改为 Protocol Event |
| Phase 4 | 移除旧 pattern matching | 旧事件监听器迁移到新 Event schema |

**关键原则**：
- MessageHub 不废，改造为 Operation-aware
- EventBus 保持纯订阅，不承载命令语义
- 两者分工明确，不混用


### 1. OperationRouter

职责：
- 接收并校验 Operation
- 路由到目标 AgentModule
- 记录 Operation 日志（用于追溯）
- 支持阻塞/非阻塞两种模式
- Ownership 校验（operation.ownerWorkerId 必须匹配或为空）

```typescript
class OperationRouter {
  // 注册 Agent 路径
  registerAgent(path: AgentPath, module: AgentModule): void;

  // 接收 Operation
  async submit(op: Operation): Promise<{ accepted: boolean; opId: string; rejected?: boolean }>;

  // 查询 Operation 状态（只返回是否已接受）
  getStatus(opId: string): { accepted: boolean; timestamp: string };

  // Ownership 校验
  validateOwnership(op: Operation, targetModule: AgentModule): boolean;
}
```

### 2. EventBus（增强版）

职责：
- 发布 Event
- 支持按类型、按分组订阅
- WebSocket 广播（带过滤）
- Event 历史查询
- 去重处理（基于 dedupKey）
- Ownership 校验（event.ownerWorkerId 必须匹配订阅方）

```typescript
class EventBus {
  // 订阅
  subscribe(type: EventType, handler: EventHandler, ownerWorkerId: string): Unsubscribe;
  subscribeByGroup(group: EventGroup, handler: EventHandler, ownerWorkerId: string): Unsubscribe;
  subscribeAll(handler: EventHandler, ownerWorkerId: string): Unsubscribe;

  // 发布（带去重）
  emit(event: Event): { emitted: boolean; dedupKey: string };

  // WebSocket 广播
  registerWsClient(ws: WebSocket, filter?: EventFilter, ownerWorkerId?: string): void;

  // 历史查询（只读）
  getHistory(filter: EventFilter, ownerWorkerId: string): Event[];
}
```

### 3. AgentModule（改造版）

职责：
- 接收来自 OperationRouter 的 Operation
- 执行并产生 Event
- 支持取消信号传播
- Ownership 约束：只处理 ownerWorkerId 匹配的 Operation

```typescript
class AgentModule {
  // 处理 Operation（带 ownership 校验）
  async handleOperation(op: Operation, cancelToken?: CancellationToken): void;

  // 发出 Event（自动填充 ownerWorkerId）
  emitEvent(event: Event): void;

  // 内部���态（不对外暴露）
  private status: AgentStatus;
  private activeOps: Map<string, OperationContext>;
  private ownerWorkerId: string;  // 所属 worker
}
```

## 数据流图

```
用户/前端
    │
    ▼ submit(Operation)
OperationRouter ──────► AgentModule.handleOperation()
    │                         │
    │                         │ execute
    │                         ▼
    │                    EventBus.emit(Event)
    │                         │
    ▼ subscribe(Event)        │ broadcast
前端/观察模块 ◄───────────────┘
```

## 可观测性：最小验收日志序列

### 必备日志链（8 条）
```
1. [request_received] → Operation 接收，{opId, from, to, intent, timestamp}
2. [operation_routed] → 路由到 AgentModule，{opId, targetPath, accepted}
3. [dispatch_queued] → Dispatch 入队列，{dispatchId, taskId, queuePosition}
4. [dispatch_started] → Dispatch 开始执行，{dispatchId, taskId, attempt}
5. [dispatch_result] → 执行结果，{dispatchId, status: success|failed|partial, evidence, exploredPaths}
6. [review_triggered] → Review 阶段触发（System），{dispatchId, reviewType}
7. [progress_reported] → 进度报告，{dispatchId, progress, message}
8. [dispatch_closed] → Dispatch 关闭，{dispatchId, closeReason, finalStatus}
```

### TraceId 贯通
- 所有日志必须携带 `traceId`（从 Operation.opId 派生）
- 跨模块传播：Operation → Event → Log
- 格式：`trace-${opId}-${sequence}`

### 日志级别
- 必备日志：INFO 级别
- 详细日志：DEBUG 级别（可关闭）
- 错误日志：ERROR 级别（必须写入）

## 兼容性策略

### Legacy Reviewer Events 映射
```
旧：reviewer_started → 新：review_started (actor: /root/finger-system-agent)
旧：reviewer_complete → 新：review_complete (actor: /root/finger-system-agent)
旧：reviewer_blocked → 新：review_blocked (actor: /root/finger-system-agent)
```

### Legacy Session 数据迁移
- 旧 session 缺失 `ownerWorkerId`：自动填充为 `system-worker-default`
- 旧 ledger 缺失 `schemaVersion`：自动填充为 `v1`
- 迁移逻辑幂等、可回放、不可静默失败

## 迁移计划

### Phase 1: 协议定义（不改业务）
- 定义 Operation/Event schema（含强制字段）
- 定义 AgentPath 类型
- 定义 SessionSource 标签（含 ownerWorkerId）
- 文档落盘

### Phase 2: 基础模块
- 实现 OperationRouter（含 ownership 校验）
- 增强 EventBus（含 schemaVersion、去重、WebSocket 过滤）
- 实现 CancellationToken 传播机制

### Phase 3: 接线（渐进）
- 把 agent dispatch 接到 OperationRouter
- 把进度、状态、完成、失败、partial 统一��成 Event 输出
- 前端改用 Event 订阅
- Legacy reviewer 事件映射到 system review

### Phase 4: 替换旧路径
- 保留兼容一段时间
- 观察稳定后删旧通信分支
- 清理 MessageHub 旧路由逻辑
- Legacy session 数据迁移完成

## 验收标准

- [ ] Operation schema 完整定义（含 opId、from、to、intent、payload 必填）
- [ ] Event schema 完整定义（含 schemaVersion、correlationId、causationId、ownerWorkerId 必填）
- [ ] AgentPath 类型实现并测试
- [ ] SessionSource 标签实现（含 ownerWorkerId）
- [ ] OperationRouter 模块实现（含 ownership 校验）
- [ ] EventBus 增强（含 schemaVersion、去重、WebSocket 过滤）
- [ ] CancellationToken 传播实现
- [ ] Dispatch 状态机含 partial 分支和 closure gate
- [ ] agent dispatch 接到 OperationRouter
- [ ] 进度/状态/partial 统一 Event 输出
- [ ] 前端 Event 订阅稳定运行
- [ ] 必备日志链 8 条全部实现
- [ ] TraceId 贯通（Operation → Event → Log）
- [ ] Legacy reviewer 事件映射完成
- [ ] Legacy session 数据迁移完成

## 参考资料

- Codex-rs SQ/EQ 模式：`codex-rs/protocol/src/protocol.rs`
- Codex AgentPath：`codex-rs/protocol/src/agent_path.rs`
- Codex ThreadManager：`codex-rs/core/src/thread_manager.rs`
- Codex InterAgentCommunication：`codex-rs/protocol/src/protocol.rs` L523-580
- Finger 现有 EventBus：`src/runtime/event-bus.ts`
- Finger 现有 MessageHub：`src/orchestration/message-hub.ts`
- Finger Session Ownership：`AGENTS.md` Worker-Owned Session / Memory（强制）

### Legacy Compatibility Mapping 表

| Legacy Event | Normalized Event | Normalized Actor | Deprecation Window |
|--------------|------------------|-------------------|-------------------|
| `reviewer_started` | `review_started` | `/root/finger-system-agent` | 2026-05-10 (30 days) |
| `reviewer_complete` | `review_complete` | `/root/finger-system-agent` | 2026-05-10 (30 days) |
| `reviewer_blocked` | `review_blocked` | `/root/finger-system-agent` | 2026-05-10 (30 days) |
| `orchestrator_dispatch` | `dispatch_task` (Op) | `/root/finger-system-agent` | 2026-05-10 (30 days) |
| `orchestrator_status_update` | `agent_status_changed` | `/root/finger-system-agent` | 2026-05-10 (30 days) |

**弃用策略**：
- 过渡期内（30 days）：旧事件自动映射为规范化事件，同时输出 `WARN` 级别日志
- 过渡期后：旧事件直接 `DROP`，不再转发
