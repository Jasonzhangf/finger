# UI 会话刷新修复 - 2026-03-13

## 问题描述

用户反馈：
1. 消息回复及时，但会话 UI 更新不及时
2. 手动刷新后依然显示"排队"
3. 状态栏状态不对，显示 ready 过一会儿才变成 processing
4. Canvas 更新了但会话未同步

## 根本原因

### 1. SESSION_MESSAGES_FETCH_LIMIT = 0

`ui/src/hooks/useWorkflowExecution.constants.ts` 中定义了 `SESSION_MESSAGES_FETCH_LIMIT = 0`，导致 `loadSessionMessages` 只请求 0 条消息：

```typescript
const response = await fetch(`/api/v1/sessions/${sessionId}/messages?limit=${SESSION_MESSAGES_FETCH_LIMIT}`);
// = /api/v1/sessions/${sessionId}/messages?limit=0
```

服务端 `getMessages` 方法对 limit <= 0 的处理：

```typescript
if (!Number.isFinite(limit) || limit <= 0) {
  return [...session.messages];  // 返回全部消息
}
```

实际上 limit=0 会返回全部消息，但 UI 端的 `loadSessionMessages` 可能存在其他问题。

### 2. runtimeEvents 被 session messages 覆盖

在 `loadSessionMessages` 中，每次加载都会直接 `setRuntimeEvents(mappedEvents)`，覆盖掉 WebSocket 实时推送的 runtimeEvents。

原有的 `mapWsMessageToRuntimeEvent` 已经正确地将 `agent_runtime_dispatch` 等事件映射为 RuntimeEvent，但这些事件被后续的 `loadSessionMessages` 调用覆盖。

## 修复方案

### 1. 移除 SESSION_MESSAGES_FETCH_LIMIT

- 删除 `SESSION_MESSAGES_FETCH_LIMIT = 0` 常量
- 修改 `loadSessionMessages` 为不传 limit 参数（使用服务端默认值 50）

### 2. 保护 WebSocket runtimeEvents

```typescript
// 实时模式下优先使用 WS 事件流；仅在首次/无 WS 事件时用 session 填充
const shouldHydrateFromSession = options?.disableRealtime === true || runtimeEventsRef.current.length === 0;
if (shouldHydrateFromSession) {
  setRuntimeEvents(mappedEvents);
}
```

### 3. 确认 WebSocket 事件映射

`mapWsMessageToRuntimeEvent` 已经正确处理 `agent_runtime_dispatch`：

```typescript
case 'agent_runtime_dispatch': {
  const target = typeof payload.targetAgentId === 'string' ? payload.targetAgentId : 'unknown-agent';
  const status = typeof payload.status === 'string' ? payload.status : 'unknown';
  const summary = typeof payload.summary === 'string' ? payload.summary : '';
  const source = typeof payload.sourceAgentId === 'string' ? payload.sourceAgentId : 'orchestrator';
  const blocking = payload.blocking === true ? 'blocking' : 'async';
  const content = summary.length > 0
    ? `[dispatch] ${source} -> ${target} (${blocking}) ${status} - ${summary}`
    : `[dispatch] ${source} -> ${target} (${blocking}) ${status}`;
  return {
    role: 'system',
    kind: 'status',
    agentId: target,
    content,
    timestamp,
  };
}
```

## 数据流分析

### 消息输入路径 (QQ Channel)

```
QQ 客户端
  ↓
QQ Gateway (openclaw-qqbot)
  ↓
ChannelBridge → MessageHub route
  ↓
dispatchTaskToAgent → AgentRuntimeBlock.dispatch
  ↓
emitDispatchEvent({ status: 'queued' })
  ↓
EventBus.emit('agent_runtime_dispatch')
  ↓
1. sessionManager.addMessage (persist to session)
2. broadcast to WebSocket clients
  ↓
UI WebSocket → mapWsMessageToRuntimeEvent → setRuntimeEvents
```

### UI 事件流

```
WebSocket message received
  ↓
processWebSocketMessage(msg)
  ↓
if (msg.type === 'agent_runtime_dispatch'):
  - scheduleSessionMessagesRefresh()  // 300ms 后刷新
  - mapWsMessageToRuntimeEvent(msg) → RuntimeEvent
  - setRuntimeEvents(prev => [...prev, newEvent])
  ↓
UI re-renders with new runtimeEvents
  ↓
ChatInterface displays updated events
```

### 潜在问题：panelFreeze

`useFrozenValue` hook 会冻结面板状态：

```typescript
const frozenRightPayload = useFrozenValue({
  executionState,
  runtimeEvents,
  ...
}, panelFreeze.right);
```

如果 `panelFreeze.right = true`，右侧面板（ChatInterface）不会更新。

用户需要检查 localStorage 中的 `finger-ui-panel-freeze` 值，确保 `right: false`。

## 验证步骤

1. 重启 daemon：`myfinger daemon restart`
2. 刷新 WebUI，清除 localStorage：
   ```javascript
   localStorage.removeItem('finger-ui-panel-freeze');
   ```
3. 通过 QQ 发送消息
4. 观察：
   - 状态栏是否立即显示"派发给 orchestrator · 状态 排队"
   - 会话是否实时更新 runtimeEvents
   - Canvas 是否同步更新

## 相关文件

- `ui/src/hooks/useWorkflowExecution.ts` - 核心 hook，处理 WebSocket 和 session messages
- `ui/src/hooks/useWorkflowExecution.constants.ts` - 常量定义
- `ui/src/hooks/useWorkflowExecution.ws.ts` - WebSocket 事件映射
- `src/server/modules/event-forwarding.ts` - EventBus → session messages + WebSocket broadcast
- `src/blocks/agent-runtime-block/index.ts` - emitDispatchEvent
- `src/server/modules/channel-bridge-hub-route.ts` - QQ channel → dispatch

## 标签

Tags: ui, session, refresh, websocket, runtimeEvents, 2026-03-13
