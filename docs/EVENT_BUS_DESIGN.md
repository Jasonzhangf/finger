# EventBus 设计文档

## 概述

统一事件总线（`UnifiedEventBus`）是 Finger 系统的消息中枢，负责：
- 本地订阅（按类型、按分组、通配符）
- WebSocket 广播（服务端过滤）
- 事件历史（内存 + 可选持久化）

## 事件类型分组

| 分组名 | 事件类型 | 用途 |
|--------|----------|------|
| `SESSION` | session_created, session_resumed, session_paused, session_compressed | 会话生命周期 |
| `TASK` | task_started, task_progress, task_completed, task_failed | 任务执行状态 |
| `TOOL` | tool_call, tool_result, tool_error | 工具调用 |
| `DIALOG` | user_message, assistant_chunk, assistant_complete | 对话流 |
| `PROGRESS` | plan_updated, workflow_progress | 整体进度 |
| `PHASE` | phase_transition, phase_output_saved, decision_tree_node | 编排阶段 |
| `RESOURCE` | resource_update, resource_shortage | 资源池状态 |
| `HUMAN_IN_LOOP` | waiting_for_user, user_decision_received | 需用户决策 |
| `SYSTEM` | system_error | 系统级错误 |
| `INPUT_LOCK` | input_lock_changed, typing_indicator | 跨端输入锁 |

## 订阅 API

### 本地订阅

```typescript
import { globalEventBus } from './runtime/event-bus.js';

// 订阅单类型
const unsub1 = globalEventBus.subscribe('task_completed', handler);

// 订阅多类型
const unsub2 = globalEventBus.subscribeMultiple(['task_started', 'task_completed'], handler);

// 订阅分组（UI 推荐）
const unsub3 = globalEventBus.subscribeByGroup('HUMAN_IN_LOOP', handler);

// 订阅所有
const unsub4 = globalEventBus.subscribeAll(handler);
```

### WebSocket 订阅（UI → 服务器）

```json
// 订阅分组 + 类型
{ "type": "subscribe", "groups": ["HUMAN_IN_LOOP", "RESOURCE"], "types": ["task_completed"] }

// 取消订阅
{ "type": "unsubscribe" }
```

服务器会确认：
```json
{ "type": "subscribe_confirmed", "groups": [...], "types": [...], "timestamp": "..." }
```

## REST API

| 端点 | 说明 |
|------|------|
| `GET /api/v1/events/types` | 返回所有支持的事件类型 |
| `GET /api/v1/events/groups` | 返回所有支持的分组 |
| `GET /api/v1/events/history?type=xxx&group=xxx&limit=50` | 按类型或分组查询历史 |

## 持久化

```typescript
// 启用持久化（写入 JSONL）
globalEventBus.enablePersistence('session-123', './logs/events');

// 禁用
globalEventBus.disablePersistence();
```

文件路径：`logs/events/<sessionId>-events.jsonl`

## 事件历史查询

```typescript
// 按类型
const events = globalEventBus.getHistoryByType('task_completed', 50);

// 按分组
const events = globalEventBus.getHistoryByGroup('HUMAN_IN_LOOP', 50);

// 按 sessionId
const events = globalEventBus.getSessionHistory('session-123', 100);
```

## 设计原则

1. **服务端过滤**：WebSocket 客户端订阅时指定分组/类型，服务器只推送匹配的事件
2. **零客户端过滤**：UI 不需要写 if/switch 判断事件类型
3. **可扩展分组**：新增事件类型只需在 `events.ts` 中加入对应分组常量
4. **类型安全**：TypeScript 类型守卫 `isXxxEvent()` 函数

## 文件结构

```
src/runtime/
├── events.ts       # 事件类型定义、分组常量、类型守卫
├── event-bus.ts    # UnifiedEventBus 实现
└── input-lock.ts   # InputLockManager 跨端输入锁
```

---

## 跨端输入锁

### 概述

`InputLockManager` 提供跨端输入互斥锁，确保多端同时接入时只有一个客户端能发送消息。

### 功能

1. **输入互斥**：同一 session 同时只有一个客户端能获取输入锁
2. **持有者可见**：所有端都能看到当前 `lockedBy`（clientId）和租约状态
3. **心跳续租**：持有者定期发送 heartbeat 续租，避免长任务中锁过期
4. **自动释放**：客户端断连或心跳超时（默认 30 秒）自动释放
5. **正在输入指示器**：支持广播 `typing_indicator` 事件

### 事件类型

| 事件类型 | 说明 | Payload |
|----------|------|---------|
| `input_lock_changed` | 锁状态变化（获取/释放/超时） | `{ sessionId, lockedBy, lockedAt, typing, lastHeartbeatAt, expiresAt }` |
| `typing_indicator` | 正在输入指示 | `{ clientId, typing }` |

### WebSocket 协议

```json
// 获取输入锁
{ "type": "input_lock_acquire", "sessionId": "session-123" }

// 响应
{
  "type": "input_lock_result",
  "sessionId": "session-123",
  "acquired": true,
  "clientId": "client-xxx",
  "state": {
    "sessionId": "session-123",
    "lockedBy": "client-xxx",
    "lockedAt": "2026-02-26T10:00:00.000Z",
    "typing": true,
    "lastHeartbeatAt": "2026-02-26T10:00:00.000Z",
    "expiresAt": "2026-02-26T10:00:30.000Z"
  }
}

// 心跳续租（仅持有者可续租）
{ "type": "input_lock_heartbeat", "sessionId": "session-123" }

// 心跳确认
{
  "type": "input_lock_heartbeat_ack",
  "sessionId": "session-123",
  "alive": true,
  "clientId": "client-xxx",
  "state": { "...": "同上" }
}

// 释放输入锁
{ "type": "input_lock_release", "sessionId": "session-123" }

// 正在输入指示
{ "type": "typing_indicator", "sessionId": "session-123", "typing": true }
```

### REST API

| 端点 | 说明 |
|------|------|
| `GET /api/v1/input-lock/:sessionId` | 查询指定 session 的锁状态 |
| `GET /api/v1/input-lock` | 查询所有活跃锁 |

### 使用示例

**服务端集成：**
```typescript
import { inputLockManager } from './runtime/input-lock.js';

// WebSocket 连接时
ws.clientId = generateClientId();

// 消息发送前
const acquired = inputLockManager.acquire(sessionId, ws.clientId);
if (!acquired) {
  ws.send(JSON.stringify({ type: 'input_lock_result', acquired: false }));
  return;
}

// 客户端断连时
inputLockManager.forceRelease(ws.clientId);
```

**UI 集成：**
```typescript
// 订阅 INPUT_LOCK 分组
ws.send(JSON.stringify({
  type: 'subscribe',
  groups: ['INPUT_LOCK'],
}));

// 发送消息前获取锁
const acquired = await acquireInputLock();
if (!acquired) {
  // 显示 "其他端正在输入" 提示
  return;
}

// 发送消息后释放锁
releaseInputLock();
```

### 设计原则

1. **最小侵入**：输入锁模块独立于 Agent 层和 Session 层
2. **事件驱动**：锁状态变化通过 EventBus 广播，所有端实时同步
3. **租约机制**：锁采用 lease + heartbeat；断连或超时自动回收
4. **UI 友好**：提供 "其他端正在输入" 视觉反馈

### 推荐时序

1. UI 连接后收到 `client_id_assigned`
2. 用户开始发送前调用 `input_lock_acquire`
3. 获取成功后每 8 秒发送 `input_lock_heartbeat`
4. 执行完成或取消时发送 `input_lock_release`
5. 如果 UI 崩溃/断连，服务端在 lease 到期后自动释放并广播 `input_lock_changed`
