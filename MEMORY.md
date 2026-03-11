# Finger 项目记忆

## 2026-03-11 标准化 Bridge 系统

### 已完成

1. **标准化 Channel Bridge 架构**
   - `src/bridges/types.ts` - 标准接口定义
   - `src/bridges/manager.ts` - 动态加载管理器
   - `src/bridges/openclaw-adapter.ts` - OpenClaw 插件适配器

2. **OpenClaw 插件自动注册为 Bridge**
   - 当 OpenClaw 插件注册 channel handler 时自动注册为 bridge module
   - 无需硬编码，支持任意 OpenClaw 标准插件

3. **QQBot 问题解决**
   - `run-qqbot-minimal.js` 参数传递错误已修复
   - `getAccessToken(APP_ID, CLIENT_SECRET)` - 分开传参
   - `getGatewayUrl(token)` - 只传 token

### 架构设计

```
OpenClaw Plugin (qqbot, weibo, etc.)
        ↓
registerChannel() → ChannelHandler 存储
        ↓
自动注册为 BridgeModule
        ↓
ChannelBridgeManager 动态加载
        ↓
OpenClawBridgeAdapter 适配
        ↓
Finger Agent 系统
```

### 待完成

1. CoreDaemon 集成 ChannelBridgeManager
2. 消息回复闭环（消息接收 → agent 处理 → 回复发送）
3. 测试真实 QQ 消息收发

Tags: bridge, openclaw, plugin, architecture
