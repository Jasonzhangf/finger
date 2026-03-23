# Mailbox + 心跳任务优先级设计

## 概述
定义系统内所有异步任务、心跳巡检、用户请求的优先级与包裹格式，保证上下文清晰且 agent 按正确顺序处理。

## 优先级顺序（从高到低）
1. **用户输入** – 直接以 `[User]` 信封出现
2. **派发任务结果** – `dispatch` 完成后通过 mailbox 返回，格式 `[System][DispatchResult]`
3. **子 Agent 报告** – 格式 `[System][AgentReport]`
4. **心跳 / 巡检任务** – 格式 `[System][Heartbeat]`，仅当前三类无待处理时执行

## 三段式邮箱消息格式
所有系统级消息统一使用以下结构：

```
[Type][Category] Title

**Short Description**: 一行简要说明
**Full Text**:
- 目标 / 停止条件
- 执行步骤
- 期望回复方式
```

示例：

```
[System][Heartbeat] Periodic Health Check

**Short Description**: 系统健康检查（每5分钟）
**Full Text**:
- 目标：检查磁盘/进程/日志/会话
- 停止条件：HEARTBEAT.md 头部 `heartbeat: off`
- 执行步骤：按顺序检查并更新 HEARTBEAT.md
- 期望回复："心跳完成" 或 "心跳已禁用"
```

## 心跳任务约束
- 最大间隔 **5 分钟**（可配置）
- agent 忙碌时跳过本次心跳
- 提供 `heartbeat.enable` / `heartbeat.disable` 工具
- 停止标记：`HEARTBEAT.md` 头部 `heartbeat: off`
- 状态仍广播到 WebUI/QQBot（用户可见，但不会抢占主会话）

## Mailbox 工具约定
- `mailbox.status`：查看总览（unread / pending / processing）
- `mailbox.list`：查看摘要列表
- `mailbox.read`：单条读取；task 会 `pending -> processing`
- `mailbox.read_all`：批量读取；默认读未读消息，适合同类消息很多时批量领取/批量已读
- `mailbox.ack`：单条提交终态（`completed|failed`），**提交成功后自动清理消息**
- `mailbox.remove`：单条删除已消费消息
- `mailbox.remove_all`：批量清理已消费消息，支持 `status/category/unreadOnly/ids/limit`
- Mailbox 默认是**内存态（ephemeral）**，不做磁盘持久化

### notification 规则
- `notification` 只在 agent **空闲** 且 **没有 actionable mailbox work** 时处理
- `notification` 读取后只写 `readAt`，**不进入 processing**
- 纯通知不要求 `ack`
- 通知过多时优先：
  1. `mailbox.read_all({ category: "notification", unreadOnly: true })`
  2. 处理/确认后再 `mailbox.remove_all({ category: "notification" })`

### task 规则
- 少量 task：逐条 `mailbox.read(id)` → 处理 → `mailbox.ack(id, ...)`
- 大量 task：先 `mailbox.read_all(...)` 批量领取，再逐条执行与 `ack`
- 未完成的 task **不能** `ack`
- task 在 `ack` 后会自动清理；`remove/remove_all` 主要用于 notification 或非标准历史清理

## 用户输入包裹策略
- 默认用户输入**不强制走邮件**，直接注入
- 第三方异步返回统一包裹为邮箱格式（便于统一优先级管理）

## 异步 dispatch 结果
- 完成后通过 `mailbox` 写入 `[System][DispatchResult]`
- 包含字段：summary、childSessionId、status、error（如有）

## 相关组件
- `heartbeat-scheduler.ts`：生成三段式心跳邮件
- `heartbeat-mailbox.ts`：存储/读取邮件
- `finger-system-agent` 提示词：内置优先级处理规则
- `dispatch.ts`：完成/失败时写入 mailbox

## 变更记录
| 日期 | 变更 |
|------|------|
| 2026-03-22 | 初版设计，定义优先级与三段式格式 |
| 2026-03-23 | 新增 `mailbox.read_all` / `mailbox.remove_all`，补充 notification idle-only 与批量处理规则 |
| 2026-03-23 | Mailbox 改为内存态不持久化；`mailbox.ack` 成功后自动清理消息 |
