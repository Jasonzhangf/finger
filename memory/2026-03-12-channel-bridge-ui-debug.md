# ChannelBridge MessageHub 集成 - UI 问题记录

## 2026-03-12 UI 问题

### 问题描述
1. **会话不显示内容**: 消息链路已通，Agent 正常执行，Canvas 更新，状态正确，但会话不显示内容
2. **缺少中间状态**: 应该先发送"正在处理中"，等待会话返回结果后再更新，现在是会话结束后一次性更新

### 当前状态
- ✅ 消息到达 Agent（执行 Canvas 任务）
- ✅ Canvas 更新正常
- ✅ 状态正确
- ❌ 会话不显示内容
- ❌ 缺少中间状态反馈

### 下一步调试
1. 检查 WebSocket 消息转发
2. 检查会话状态更新逻辑
3. 检查 mailbox 消息创建和更新
4. 检查 EventBus 事件触发

Tags: channel-bridge, messagehub, ui-debug, session-display, 2026-03-12
