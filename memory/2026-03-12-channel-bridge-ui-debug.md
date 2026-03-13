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

## 2026-03-12 晚间链路阻塞与丢失现象

### 现象
- QQ 输入明显变慢，先提示“正在回复/处理中”，随后长时间无响应。
- 有请求未进入处理链路（刷新 UI 后显示空闲/排队卡住）。
- QQ 插件日志出现：`No response within timeout`。

### 关键时间差证据
- 2026-03-12 21:49:57.336（收到 QQ 消息）
- 2026-03-12 21:58:09.845（真正 sendMessage 发送）
- 相差约 492 秒，说明“回复发送”被阻塞到任务完成后。

### 核心原因定位
- `openclaw-qqbot` 调用 `dispatchReplyWithBufferedBlockDispatcher` 时同步等待。
- 当前实现中 `bridge.callbacks_.onMessage(message)` 被 `await`，导致 QQ 插件线程被阻塞。
- 2 分钟内未返回会触发 `No response within timeout`，后续回复延迟或丢失。
- UI 显示“排队”实际是 dispatch 事件停在 queued，任务未进入执行或执行结果未回传。

### 修复方向（待实施）
1. `dispatchReplyWithBufferedBlockDispatcher` 内立即 `deliver` 一条“已收到，正在处理中…”。
2. `bridge.callbacks_.onMessage(...)` 改成 **不 await**（后台执行，防止输入阻塞）。
3. 补充失败/超时可视化提示，避免“沉默丢失”。
4. UI 端在插入“处理中”后强制刷新。

Tags: channel-bridge, messagehub, qqbot, blocking, deliver, timeout, ui, 2026-03-12

## 2026-03-13 修复: QQ 通道统一接入 /api/v1/message 路径

### 问题
- QQ 通道消息通过 `channel-bridge-hub-route` 直连 `dispatchTaskToAgent`，绕过了 `/api/v1/message` 路由
- 导致 QQ 通道无法解析 `<##@...##>` 超级命令（如 `<##@system##>`, `<##help##>`）
- QQ 通道也没有执行 channel policy 检查（direct vs mailbox）

### 解决方案
在 `channel-bridge-hub-route.ts` 中添加：
1. 导入 `parseSuperCommand` + 所有 command handlers
2. 在 dispatch 前先解析 super commands，匹配则执行并返回
3. 添加 channel policy 检查（`loadFingerConfig` + `getChannelAuth`）
4. 注入 `eventBus` 依赖以支持 session_changed 事件

### 修改文件
- `src/server/modules/channel-bridge-hub-route.ts` - 添加 super command 解析 + policy 检查
- `src/server/index.ts` - 注入 eventBus + 修复 mockRuntimeKit 依赖

### 验收标准
- QQ 通道发送 `<##@system##>` 应正确响应
- QQ 通道发送 `<##help##>` 应返回命令列表
- channel policy 配置生效（direct vs mailbox）
- 构建 `npm run build:backend` 通过

