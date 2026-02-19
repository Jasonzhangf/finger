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
└── event-bus.ts    # UnifiedEventBus 实现
```
