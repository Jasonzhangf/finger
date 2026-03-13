# Agent Context Persistence Fix (2026-03-13)

## 问题

用户报告：切换到 System Agent 后又跳回 Orchestrator

**期望行为**：
- 切到 system 只切一次，不切 agent 就一直是 system
- 切了 agent，不切项目就是当前上下文
- 直到切 project、切 session 或切 system

## 根本原因

`ChannelContextManager` 没有在所有 agent 切换命令上更新上下文，导致：
1. `<##@system##>` 切换后保存了上下文
2. 但 `<##@agent:*>` 命令没有更新上下文
3. 普通消息派发时读取的是旧上下文

## 修复方案

### 1. 上下文更新点

在 `channel-bridge-hub-route.ts` 中添加上下文更新：

```typescript
// System 命令
if (firstBlock.type === 'system') {
  const result = await handleSystemCommand(sessionManager, eventBus);
  channelContextManager.updateContext(
    channelMsg.channelId,
    'system',
    'finger-system-agent'
  );
  await sendReply(result, 'messagehub');
  return;
}

// Agent 命令
if (firstBlock.type === 'agent_list') {
  const result = await handleAgentList(sessionManager, firstBlock.path);
  channelContextManager.updateContext(
    channelMsg.channelId,
    'business',
    'finger-orchestrator'
  );
  await sendReply(result, 'messagehub');
  return;
}

// Project 切换
if (firstBlock.type === 'project_switch' && firstBlock.path) {
  const result = await handleProjectSwitch(sessionManager, firstBlock.path, eventBus);
  channelContextManager.updateContext(
    channelMsg.channelId,
    'business',
    'finger-orchestrator'
  );
  await sendReply(result, 'messagehub');
  return;
}
```

### 2. 上下文读取逻辑

`ChannelContextManager.getTargetAgent()`:
```typescript
getTargetAgent(channelId: string, parsed: { type: string; targetAgent: string }): string {
  // Super command 明确指定目标 agent
  if (parsed.type === 'super_command' && parsed.targetAgent) {
    return parsed.targetAgent;
  }

  // 否则使用持久化的上下文
  const ctx = this.contexts.get(channelId);
  if (ctx) {
    return ctx.currentAgentId;
  }

  // 默认 orchestrator
  return 'finger-orchestrator';
}
```

### 3. 单例模式

```typescript
export class ChannelContextManager {
  static #instance: ChannelContextManager;

  static getInstance(): ChannelContextManager {
    if (!ChannelContextManager.#instance) {
      ChannelContextManager.#instance = new ChannelContextManager();
    }
    return ChannelContextManager.#instance;
  }
}
```

## 行为说明

### Agent 切换命令

| 命令 | 目标 Agent | 上下文更新 | 持久性 |
|------|-----------|----------|--------|
| `<##@system##>` | finger-system-agent | ✓ 更新 | 持久 |
| `<##@agent##>` | finger-orchestrator | ✓ 更新 | 持久 |
| `<##@agent:list##>` | finger-orchestrator | ✓ 更新 | 持久 |
| `<##@agent:new##>` | finger-orchestrator | ✓ 更新 | 持久 |
| `<##@agent:switch@id##>` | finger-orchestrator | ✓ 更新 | 持久 |
| `<##@project:switch@path##>` | finger-orchestrator | ✓ 更新 | 持久 |

### 普通消息

- 如果当前上下文是 system agent → 发送到 system agent
- 如果当前上下文是 orchestrator → 发送到 orchestrator
- 直到用户明确切换

### Provider 切换（不影响 Agent 上下文）

- `<##@system:provider:list##>` - 列出 providers
- `<##@system:provider:switch@id##>` - 切换 provider
- 这些命令不改变 agent 上下文

## 存储位置

`~/.finger/config/channel-contexts.json`:
```json
{
  "qqbot:default": {
    "channelId": "qqbot:default",
    "currentMode": "system",
    "currentAgentId": "finger-system-agent",
    "switchedAt": 1741925367570
  }
}
```

## 验证

1. 切换到 system agent → 后续消息都发到 system agent ✓
2. 切换到 orchestrator → 后续消息都发到 orchestrator ✓
3. 切换 project → 重置为 orchestrator ✓
4. Provider 切换 → 不影响 agent 上下文 ✓

## 相关文件

- `src/orchestration/channel-context-manager.ts` - 上下文管理
- `src/server/modules/channel-bridge-hub-route.ts` - 上下文更新
- `src/server/middleware/super-command-parser.ts` - 命令解析

## Commit

- `de55d80` - fix: Ensure agent context persistence on all agent commands

Tags: agent-context, persistence, channel-bridge, messagehub, system-agent
