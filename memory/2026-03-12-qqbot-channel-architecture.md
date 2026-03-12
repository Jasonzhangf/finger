# QQ Bot Channel Architecture Review

## Current Architecture (错误 - 绕过 MessageHub)

```
QQ 客户端
    ↓
QQ Gateway (openclaw-qqbot)
    ↓
ChannelBridge callbacks (openclaw-adapter)
    ↓
Server.dispatchTaskToAgent  ← 直接调用,绕过 MessageHub
    ↓
Agent Response
    ↓
Server.sendReply
    ↓
ChannelBridge.sendMessage
    ↓
QQ API
```

### 问题
1. **绕过 MessageHub**: QQ 消息不经过 MessageHub 的 route/input/output 机制
2. **msg_id 丢失**: `dispatchReplyWithBufferedBlockDispatcher` 生成新的 `qqbot-timestamp` ID，而 QQ 原始 `msg_id` 丢失
3. **replyTo 错误**: Server 使用 `msg.id` 而不是 `msg.metadata.messageId`，导致 QQ API 拒绝

## Correct Architecture (必须统一到 MessageHub)

```
QQ 客户端
    ↓
QQ Gateway (openclaw-qqbot)
    ↓
ChannelBridge → MessageHub INPUT (新)
    ↓
MessageHub.route() → Agent OUTPUT
    ↓
Agent Response → MessageHub OUTPUT (新)
    ↓
ChannelBridge.sendMessage
    ↓
QQ API
```

### 修复方案

1. **接入 MessageHub**: 把 QQBot 通道注册为 MessageHub 的 input/output module
2. **统一路由**: Server 只做 route 注册，不再直接 dispatchTaskToAgent
3. **msg_id 修复**: 使用 `metadata.messageId` 作为 replyTo

## 代码位置

- 入口: `src/blocks/openclaw-plugin-manager/openclaw-api-adapter.ts:dispatchReplyWithBufferedBlockDispatcher`
  - 错误: `message.id = qqbot-${Date.now()}` (自生成)
  - 正确: `message.id = ctx.MessageSid` (原始 QQ msg_id)
- 出口: `src/server/index.ts:sendReply`
  - 错误: `replyTo: msg.id`
  - 正确: `replyTo: msg.metadata?.messageId`

## 修复步骤

1. 立即修复: `src/server/index.ts` - 使用 `metadata.messageId`
2. 架构重构: 将 QQ 通道接入 MessageHub
3. 测试验证: 完整双向链路测试

Tags: qqbot, channel-bridge, messagehub, architecture, msg_id, bug

## 2026-03-12 修复记录

### 已修复

1. **msg_id 传递修复** (src/blocks/openclaw-plugin-manager/openclaw-api-adapter.ts)
   - 修改前: `message.id = qqbot-${Date.now()}-${random}` (自生成ID覆盖原始ID)
   - 修改后: `message.id = messageId || qqbot-${Date.now()}-${random}` (优先使用原始QQ消息ID)
   - metadata 中始终保留原始 messageId

2. **replyTo 逻辑验证** (src/server/index.ts)
   - 已确认正确: `replyTo: (msg.metadata?.messageId as string) || msg.id`
   - fallback 机制: 如果 metadata.messageId 不存在，使用 msg.id

### 消息链路流程

```
QQ消息 → OpenClaw插件
  → dispatchReplyWithBufferedBlockDispatcher
  → ChannelMessage.id = ctx.MessageSid (原始QQ msg_id)
  → bridge.callbacks_.onMessage(message)
  → Server.onMessage → dispatchTaskToAgent → Agent
  → Server.sendReply(replyTo: metadata.messageId)
  → ChannelBridge.sendMessage(replyToId: replyTo)
  → QQ API (replyToId 对应原始消息)
```

### 待完成

- 测试真实QQ消息收发闭环
- 评估并规划接入 MessageHub 统一路由架构

Tags: qqbot, msg_id, fix, 2026-03-12

## 2026-03-12 验证结果

- ✅ QQ 消息收发闭环已验证通过（本地回复正常）
- ✅ 用户已完成 git 提交

Tags: qqbot, verification, git, 2026-03-12
