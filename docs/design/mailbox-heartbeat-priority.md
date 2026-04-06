## 执行模式说明（重要）

**本系统是 Agent-driven 异步执行模式，不是刚性 dispatch 等待模式**：

| 特性 | 实际执行 | 非刚性假设 |
|------|----------|------------|
| **心跳触发** | mailbox.append → Agent 被动响应 | ❌ dispatch → 等待完成 |
| **响应时间** | 不确定（可能立即/延迟/不响应） | ❌ 假设刚性执行、可等待 |
| **超时概念** | mailbox 消息可能一直 pending | ❌ dispatch timeout 2 分钟 |
| **状态流转** | pending → processing → completed/failed | ❌ RUNNING → PAUSED 状态机 |
| **控制权** | Agent 通过 Kernel Tool 请求 | ❌ 系统强制干预 |

**关键修正**：
- 超时检测基于 **mailbox 状态**（堆积/卡死），而非 dispatch timeout
- Agent 响应时间不确定，心跳写入 mailbox 后不等待响应
- Agent 控制权有限，只能请求操作，不能强制干预系统

# Mailbox + 心跳任务优先级设计

## 概述
定义系统内所有异步任务、心跳巡检、用户请求的优先级与包裹格式，保证上下文清晰且 agent 按正确顺序处理。

**核心设计原则**：
1. **容错优先** - 错误不能静默失败，必须有记录和处理
2. **持续执行** - 非致命错误不阻断心跳，支持降级运行
3. **Agent 控制权** - 模型可以停止心跳、清理 mailbox
4. **审计追踪** - 所有事件写入 Ledger

---

## 优先级顺序（从高到低）
1. **用户输入** – 直接以 `[User]` 信封出现
2. **派发任务结果** – `dispatch` 完成后通过 mailbox 返回，格式 `[System][DispatchResult]`
3. **子 Agent 报告** – 格式 `[System][AgentReport]`
4. **心跳 / 巡检任务** – 格式 `[System][Heartbeat]`，仅当前三类无待处理时执行

---

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

---

## 心跳任务约束
- 最大间隔 **5 分钟**（可配置）
- agent 忏碌时跳过本次心跳
- 提供 `heartbeat.enable` / `heartbeat.disable` 工具
- 停止标记：`HEARTBEAT.md` 头部 `heartbeat: off`
- 状态仍广播到 WebUI/QQBot（用户可见，但不会抢占主会话）

---

## 心跳状态机设计

### 状态定义

| 状态 | 说明 | 触发条件 | 可恢复 |
|------|------|----------|--------|
| **RUNNING** | 正常运行 | 启动或 resume | ✅ |
| **PAUSED** | 暂停 | 连续失败或 agent 主动暂停 | ✅ 可 resume |
| **DEGRADED** | 降级运行 | 单次失败但未达暂停阈值 | ✅ 自动恢复 |
| **STOPPED** | 停止 | agent 主动停止或致命错误 | ❌ 需手动重启 |

### 状态转换图

```
                    ┌──────────────────────────────────────┐
                    │           INITIAL (未启动)            │
                    └──────────────────────────────────────┘
                                      │
                                      │ start()
                                      ▼
                    ┌──────────────────────────────────────┐
                    │           RUNNING (运行中)            │◄─────┐
                    │  - 每 5 分钟写入 mailbox             │      │
                    │  - 不等待 Agent 响应                 │      │ 写入成功
                    │  - 检测 mailbox 健康                 │──────┘
                    └──────────────────────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
              │ mailbox 堆积          │ 消息卡死              │ Agent 主动停止
              │ (pending > 50)        │ (processing > 30min) │ (stop_heartbeat)
              ▼                       ▼                       ▼
    ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
    │  DEGRADED        │   │  PAUSED          │   │  STOPPED         │
    │  (降级运行)      │   │  (暂停)          │   │  (停止)          │
    │  - 降低心跳频率   │   │  - 暂停写入      │   │  - 永久停止      │
    │  - 10分钟间隔    │   │  - 等待清理      │   │  - 需手动重启    │
    │  - 记录堆积      │   │  - 可 resume    │   │  - 记录停止原因  │
    │  - 可自动恢复    │   │  - 记录暂停原因 │   └──────────────────┘
    └──────────────────┘   └──────────────────┘
```

---

## 错误分级 + 处理策略

### 错误级别定义

| 错误级别 | 定义 | 处理方式 | 示例 |
|----------|------|----------|------|
| **Minor (轻微)** | 不影响下一轮心跳 | 记录 Ledger + 继续 | 单条消息 ack 失败 |
| **Major (严重)** | 需要降级处理 | 记录 Ledger + 跳过失败项 + 降级 | dispatch 超时（1-2 次） |
| **Critical (致命)** | 必须停止心跳 | 记录 Ledger + 暂停 + 告警 | agent crash、连续 3 次超时 |

### 连续失败阈值

```typescript
const HEARTBEAT_CONFIG = {
  intervalMs: 300000,           // 5 分钟
  dispatchTimeoutMs: 120000,    // 2 分钟
  maxConsecutiveFailures: 3,    // 连续失败 3 次后暂停
  degradedThreshold: 1,         // 单次失败后进入降级
  autoResumeAfterMs: 600000,    // 暂停后 10 分钟自动恢复（可选）
};
```

### 错误处理流程

```
心跳触发
    │
    ├──► dispatch 创建成功 ──► 等待完成
    │                              │
    │                              ├──► 完成 ──► 重置失败计数 ──► RUNNING
    │                              │
    │                              └──► 超时/失败
    │                                      │
    │                                      ├──► 失败计数++
    │                                      │
    │                                      ├──► 失败计数 < 3 ──► DEGRADED（继续心跳）
    │                                      │
    │                                      └──► 失败计数 >= 3 ──► PAUSED（暂停）
    │                                              │
    │                                              └──► 写入 Ledger（critical）
    │                                              └──► 告警（可选）
    │                                              └──► 等待 resume
    │
    └──► dispatch 创建失败 ──► 记录 Ledger（major）──► DEGRADED
```

---

## 心跳控制接口

### HeartbeatScheduler API

```typescript
interface HeartbeatScheduler {
  // 启动心跳
  start(): Promise<void>;
  
  // 停止心跳（永久）
  stopHeartbeat(reason: string): Promise<HeartbeatControlResult>;
  
  // 暂停心跳（可恢复）
  pauseHeartbeat(reason: string, resumeAfterMinutes?: number): Promise<HeartbeatControlResult>;
  
  // 恢复心跳
  resumeHeartbeat(): Promise<HeartbeatControlResult>;
  
  // 查询状态
  getStatus(): Promise<HeartbeatStatus>;
}

interface HeartbeatStatus {
  status: 'running' | 'paused' | 'degraded' | 'stopped';
  consecutiveFailures: number;
  lastSuccess?: Date;
  lastFailure?: { reason: string; at: Date; severity: 'minor' | 'major' | 'critical' };
  nextHeartbeat?: Date;
  autoResumeAt?: Date;
}

interface HeartbeatControlResult {
  ok: boolean;
  previousStatus: string;
  newStatus: string;
  reason?: string;
}
```

---

## Mailbox 控制接口

### MailboxBlock API

```typescript
interface MailboxBlock {
  // 已有接口
  read(messageId?: string): Promise<MailboxMessage[]>;
  readAll(filter?: MailboxFilter): Promise<MailboxMessage[]>;
  ack(messageId: string, status: 'completed' | 'failed', result?: string): Promise<void>;
  remove(messageId: string): Promise<void>;
  removeAll(filter?: MailboxRemoveFilter): Promise<number>;
  
  // 新增接口
  clear(status: 'read' | 'skipped' | 'failed', olderThanHours?: number): Promise<MailboxClearResult>;
  markSkip(messageIds: string[], reason: string): Promise<MailboxSkipResult>;
  ackAll(messageIds: string[], status: 'completed' | 'failed'): Promise<MailboxAckAllResult>;
  getStatus(): Promise<MailboxStatus>;
}

interface MailboxStatus {
  unread: number;
  read: number;
  processing: number;
  skipped: number;
  failed: number;
  oldestUnread?: Date;
}

interface MailboxClearResult {
  ok: boolean;
  cleared: number;
  retained: number;
}

interface MailboxSkipResult {
  ok: boolean;
  skipped: number;
  reason: string;
}

interface MailboxAckAllResult {
  ok: boolean;
  acked: number;
  failed: Array<{ id: string; reason: string }>;
}
```

---

## Kernel Tools 设计（暴露给模型）

### Tool 1: stop_heartbeat

```json
{
  "name": "stop_heartbeat",
  "description": "Stop heartbeat scheduler permanently or temporarily",
  "input_schema": {
    "type": "object",
    "properties": {
      "reason": { "type": "string", "description": "必须填写停止原因" },
      "permanent": { "type": "boolean", "description": "true=永久停止，false=暂停" },
      "resume_after_minutes": { "type": "number", "description": "暂停后自动恢复时间（仅当 permanent=false）" }
    },
    "required": ["reason", "permanent"]
  }
}
```

### Tool 2: resume_heartbeat

```json
{
  "name": "resume_heartbeat",
  "description": "Resume paused heartbeat scheduler",
  "input_schema": {
    "type": "object",
    "properties": {}
  }
}
```

### Tool 3: get_heartbeat_status

```json
{
  "name": "get_heartbeat_status",
  "description": "Get current heartbeat scheduler status",
  "input_schema": {
    "type": "object",
    "properties": {}
  }
}
```

### Tool 4: mailbox_clear

```json
{
  "name": "mailbox_clear",
  "description": "Clear mailbox messages by status",
  "input_schema": {
    "type": "object",
    "properties": {
      "status": { 
        "type": "string", 
        "enum": ["read", "skipped", "failed"],
        "description": "清理哪种状态的消息"
      },
      "older_than_hours": { 
        "type": "number", 
        "description": "只清理超过 N 小时的消息（可选）"
      }
    },
    "required": ["status"]
  }
}
```

### Tool 5: mailbox_mark_skip

```json
{
  "name": "mailbox_mark_skip",
  "description": "Mark messages as skipped (will not be processed)",
  "input_schema": {
    "type": "object",
    "properties": {
      "message_ids": { 
        "type": "array", 
        "items": { "type": "string" },
        "description": "要跳过的消息 ID 列表"
      },
      "reason": { 
        "type": "string", 
        "description": "跳过原因（必填）"
      }
    },
    "required": ["message_ids", "reason"]
  }
}
```

### Tool 6: mailbox_get_status

```json
{
  "name": "mailbox_get_status",
  "description": "Get mailbox statistics",
  "input_schema": {
    "type": "object",
    "properties": {}
  }
}
```

---

## 心跳 Prompt 注入设计

### Inject Prompt 内容

当心跳触发时，注入以下控制说明：

```
## 心跳控制能力

当前心跳状态：{{status}}
连续失败次数：{{consecutiveFailures}}
上次成功：{{lastSuccess}}
上次失败：{{lastFailure}}

你有以下控制能力：

1. **停止心跳**：
   - stop_heartbeat(reason="...", permanent=true)  // 永久停止
   - stop_heartbeat(reason="...", permanent=false, resume_after_minutes=10)  // 暂停 10 分钟

2. **恢复心跳**：
   - resume_heartbeat()  // 从暂停恢复

3. **查询状态**：
   - get_heartbeat_status()  // 查看详细状态

4. **清理 Mailbox**：
   - mailbox_clear(status="read")  // 清理已读消息
   - mailbox_clear(status="failed", older_than_hours=24)  // 清理 24 小时前的失败消息
   - mailbox_mark_skip(ids=["msg-1", "msg-2"], reason="重复通知无需处理")  // 标记跳过

使用场景：
- 发现任务阻塞/循环错误 → 暂停心跳，清理 mailbox
- 发现重复无效消息 → 标记跳过
- 任务恢复正常 → 恢复心跳
- 系统维护 → 暂停心跳
```

---

## Ledger 审计追踪设计

### 心跳事件类型

```typescript
type HeartbeatEventType =
  | 'heartbeat_dispatch_start'
  | 'heartbeat_dispatch_complete'
  | 'heartbeat_dispatch_timeout'
  | 'heartbeat_dispatch_failed'
  | 'heartbeat_paused'
  | 'heartbeat_resumed'
  | 'heartbeat_stopped'
  | 'heartbeat_degraded'
  | 'heartbeat_auto_resume'
  | 'mailbox_cleared'
  | 'mailbox_marked_skip'
  | 'mailbox_ack_failed';

interface HeartbeatLedgerEntry {
  eventId: string;
  timestamp: Date;
  eventType: HeartbeatEventType;
  
  payload: {
    seq: number;
    dispatchId?: string;
    messageId?: string;
    error?: { code: string; message: string; stack?: string };
    reason?: string;  // 人工操作原因
    stats?: {
      duration_ms: number;
      messagesProcessed: number;
      messagesAcked: number;
      messagesSkipped: number;
    };
  };
  
  severity: 'info' | 'warn' | 'error' | 'critical';
}
```

### Ledger 写入规则

| 事件 | severity | 必写字段 |
|------|----------|----------|
| dispatch_start | info | seq, dispatchId |
| dispatch_complete | info | seq, dispatchId, stats |
| dispatch_timeout | warn | seq, dispatchId, error, duration_ms |
| dispatch_failed | error | seq, dispatchId, error |
| paused | warn | reason, consecutiveFailures |
| resumed | info | reason |
| stopped | critical | reason |
| mailbox_cleared | info | cleared count |
| mailbox_marked_skip | info | skipped count, reason |

---

## 实施计划

| 步骤 | 任务 | 文件 | 预计时间 |
|------|------|------|----------|
| 1 | HeartbeatScheduler 添加状态机 | `src/server/modules/heartbeat-scheduler.ts` | 30min |
| 2 | 实现 stop/pause/resume | `src/server/modules/heartbeat-scheduler.impl.ts` | 30min |
| 3 | MailboxBlock 添加 clear/markSkip | `src/blocks/mailbox-block/index.ts` | 20min |
| 4 | 创建 heartbeat control tools | `src/tools/internal/heartbeat-control-tools.ts` | 20min |
| 5 | 创建 mailbox control tools | `src/tools/internal/mailbox-control-tools.ts` | 20min |
| 6 | Ledger 事件记录 | `src/orchestration/heartbeat-ledger.ts` | 20min |
| 7 | Heartbeat inject prompt 更新 | `src/server/modules/heartbeat-scheduler.impl.ts` | 15min |
| 8 | 单元测试 | `tests/unit/server/heartbeat-control.test.ts` | 30min |
| 9 | 集成测试 | `tests/integration/heartbeat-lifecycle.test.ts` | 30min |
| 10 | E2E 测试 | `tests/e2e/heartbeat-error-recovery.test.ts` | 30min |

---

## 验收标准

| 场景 | 验收标准 |
|------|----------|
| **dispatch 超时** | 连续 3 次后自动暂停，写入 Ledger（critical），可手动 resume |
| **消息处理失败** | 标记 failed 状态，跳过，记录 Ledger（minor），不阻塞下一轮 |
| **mailbox 清理** | clear() 返回清理数量，已读消息可保留审计 |
| **心跳停止** | stopHeartbeat() 后不再 dispatch，状态查询正确 |
| **错误记录** | 所有错误写入 Ledger，severity 正确 |
| **模型感知** | inject prompt 包含控制说明，模型可调用 tools |
| **降级运行** | 单次失败后继续心跳，但标记 degraded 状态 |

---

## Mailbox 工具约定（已有）
- `mailbox.status`：查看总览（unread / pending / processing）
- `mailbox.list`：查看摘要列表
- `mailbox.read`：单条读取；task 会 `pending -> processing`
- `mailbox.read_all`：批量读取；默认读未读消息
- `mailbox.ack`：单条提交终态（`completed|failed`）
- `mailbox.remove`：单条删除已消费消息
- `mailbox.remove_all`：批量清理已消费消息

---

## 变更记录
| 日期 | 变更 |
|------|------|
| 2026-03-22 | 初版设计，定义优先级与三段式格式 |
| 2026-03-23 | 新增 `mailbox.read_all` / `mailbox.remove_all`，补充 notification idle-only 与批量处理规则 |
| 2026-03-23 | Mailbox 改为内存态不持久化；`mailbox.ack` 成功后自动清理消息 |
| 2026-04-06 | 新增心跳状态机、错误分级、容错设计、控制接口、Kernel Tools、Ledger 审计追踪 |
