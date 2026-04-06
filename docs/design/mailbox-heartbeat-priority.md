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
| **Minor (轻微)** | mailbox status=failed | 记录 Ledger + 继续 | Agent 处理失败但 ack 了 |
| **Major (严重)** | pendingCount > 50 或 age > 1h | 记录 Ledger + 降级 + 继续心跳 | mailbox 堆积 |
| **Critical (致命)** | processing age > 30min | 记录 Ledger + 暂停 + 告警 | 消息卡死 |

### 连续失败阈值（改为 Mailbox 健康检测参数）

```typescript
const HEARTBEAT_CONFIG = {
  intervalMs: 300000,              // 5 分钟写入 mailbox
  mailboxPendingThreshold: 50,     // pending 消息堆积阈值
  mailboxPendingAgeMs: 3600000,    // pending 消息超时阈值（1 小时）
  mailboxProcessingAgeMs: 1800000, // processing 消息卡死阈值（30 分钟）
  degradedIntervalMs: 600000,      // 降级后 10 分钟间隔
  autoResumeAfterMs: 600000,       // 暂停后 10 分钟自动恢复（可选）
};
```

### 错误处理流程（基于 Mailbox 健康）

```
心跳写入 mailbox
    │
    ├──► 写入成功 ──► 不等待响应 ──► 继续下一轮
    │
    └──► 写入失败
            │
            └──► 记录 Ledger ──► Minor 错误（继续下一轮）

Mailbox 健康检测（每轮心跳时检查）
    │
    ├──► pendingCount <= 50 且 age < 1h
    │       │
    │       └──► 正常 ──► RUNNING
    │
    ├──► pendingCount > 50 或 pending age > 1h
    │       │
    │       └──► 堆积 ──► 记录 Ledger ──► Major ──► DEGRADED
    │
    └──► processing age > 30min 或 Agent 无响应
            │
            └──► 卡死 ──► 记录 Ledger ──► Critical ──► PAUSED
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

## Agent 能力边界

**Agent 可请求的操作（通过 Kernel Tool）**：

| Agent 能做什么 | Agent 不能做什么 |
|----------------|------------------|
| ✅ 调用 stop_heartbeat 停止心跳 | ❌ 强制清理其他 agent 的 mailbox |
| ✅ 调用 mailbox_clear 清理自己的 mailbox | ❌ 重启 daemon |
| ✅ 调用 mailbox_mark_skip 标记跳过 | ❌ 强制恢复心跳（需系统干预） |
| ✅ 调用 resume_heartbeat 恢复心跳（如果 paused） | ❌ 修改系统配置 |
| ✅ 调用 get_heartbeat_status 查询状态 | ❌ 删除其他 agent 的 ledger |

**关键原则**：
- Agent 的请求是**意图表达**，系统决定是否执行
- 系统可能拒绝请求（如：STOPPED 状态无法 resume）
- Agent 只能操作自己的 mailbox，不能干预其他 agent

---

## Agent 决策触发条件（关键）

Agent 在以下场景应主动决策，避免系统进入死循环或浪费 token：

| 检测信号 | 推荐操作 | 判断依据 | 优先级 |
|----------|----------|----------|--------|
| **mailbox pending > 50** | `stop_heartbeat(reason="mailbox堆积", permanent=false, resume_after_minutes=30)` | `mailbox_get_status()` 显示 pending > 50 | P0 |
| **同一消息 processing > 10min** | `mailbox_mark_skip(ids=[...], reason="消息卡死")` | 单条消息处理时间过长 | P0 |
| **连续 3 次相同错误** | `stop_heartbeat(reason="循环错误", permanent=false)` | Ledger 显示相同 error 重复 3 次 | P0 |
| **重复心跳消息（间隔 < 5min）** | `mailbox_mark_skip(ids=[...], reason="重复心跳")` | mailbox.list() 发现相��� title + 时间差 < 5min | P0 |
| **任务阻塞且无进展** | `mailbox_clear(status="read")` + `resume_heartbeat()` | mailbox 堆积已清理，可恢复 | P1 |
| **非窗口期重复启动** | `stop_heartbeat(reason="非窗口期", permanent=false, resume_after_minutes=60)` | 当前时间不在 nightly/daily 窗口 | P1 |
| **系统维护** | `stop_heartbeat(reason="维护", permanent=true)` | 人工明确指示停止 | P2 |

### Agent 判断逻辑示例

**场景：mailbox 堆积检测**
```
1. Agent 收到心跳消息
2. 调用 mailbox_get_status()
3. 发现 pending = 62 (> 50)
4. 调用 stop_heartbeat(reason="mailbox堆积62条", permanent=false, resume_after_minutes=30)
5. 系统状态转为 PAUSED + 写入 Ledger
```

**场景：重复消息去重**
```
1. Agent 收到心跳消息
2. 调用 mailbox.list()
3. 发现 3 条相同 title "[System][Heartbeat] Periodic Health Check"
4. 检查时间戳：相差 < 5min
5. 调用 mailbox_mark_skip(ids=["msg-2", "msg-3"], reason="重复心跳，间隔<5min")
6. Ledger 记录 mailbox_marked_skip + skipped=2
```

**场景：循环错误检测**
```
1. Agent 收到心跳消息
2. 调用 get_heartbeat_status()
3. 发现 lastFailure.reason = "dispatch_failed" + consecutiveFailures = 3
4. 检查 Ledger：连续 3 次 error.code = "E_TIMEOUT"
5. 调用 stop_heartbeat(reason="连续3次dispatch超时", permanent=false)
6. 系统状态转为 PAUSED + 写入 Ledger
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
  | 'heartbeat_mailbox_write'
  | 'heartbeat_mailbox_write_failed'
  | 'mailbox_backlog_detected'
  | 'mailbox_stale_detected'
  | 'heartbeat_degraded'
  | 'heartbeat_resumed'
  | 'heartbeat_stopped'
  | 'heartbeat_degraded'
  | 'agent_resume_request'
  | 'mailbox_cleared'
  | 'mailbox_marked_skip'
  | 'agent_stop_request';

interface HeartbeatLedgerEntry {
  eventId: string;
  timestamp: Date;
  eventType: HeartbeatEventType;
  
  payload: {
    seq: number;
    mailboxStats?: {
      pending: number;
      processing: number;
      oldestPendingAgeMs: number;
      oldestProcessingAgeMs: number;
    };
    messageId?: string;
    messageIds?: string[];
    clearedCount?: number;
    skippedCount?: number;
    previousStatus?: string;
    newStatus?: string;
    error?: { code: string; message: string; stack?: string };
    reason?: string;  // 人工操作原因
    stats?: {
      intervalMs: number;
      pendingThreshold: number;
    };
  };
  
  severity: 'info' | 'warn' | 'error' | 'critical';
}
```

### Ledger 写入规则

| 事件 | severity | 必写字段 |
|------|----------|----------|
| heartbeat_mailbox_write | info | seq, mailboxStats |
| heartbeat_mailbox_write_failed | error | seq, error |
| heartbeat_status_change | warn | previousStatus, newStatus, reason |
| heartbeat_degraded | warn | seq, mailboxStats |
| heartbeat_resumed | info | reason |
| heartbeat_stopped | critical | reason |
| mailbox_health_check | info | seq, mailboxStats |
| mailbox_backlog_detected | warn | seq, mailboxStats |
| mailbox_stale_detected | error | seq, mailboxStats |
| mailbox_cleared | info | clearedCount |
| mailbox_marked_skip | info | skippedCount, reason |
| agent_stop_request | warn | reason |
| agent_resume_request | info | reason |

---

## 实施计划

**按顺序实施，每步完成后运行对应测试**：

| 步骤 | 任务 | 文件 | 预计时间 |
|------|------|------|----------|
| 1 | Mailbox 健康检测逻辑 | `src/serverx/modules/heartbeat-scheduler.impl.ts` | 20min |
| 2 | Heartbeat 状态机实现 | `src/serverx/modules/heartbeat-scheduler.impl.ts` | 30min |
| 3 | Mailbox clear/markSkip 实现 | `src/blocks/mailbox-block/index.ts` | 20min |
| 4 | Kernel Tools 创建 | `src/tools/internal/heartbeat-control-tools.ts` | 30min |
| 5 | Kernel Tools 创建 | `src/tools/internal/mailbox-control-tools.ts` | 20min |
| 6 | Ledger 事件记录 | `src/orchestration/heartbeat-ledger.ts` | 20min |
| 7 | Prompt 注入更新 | `src/serverx/modules/heartbeat-scheduler.impl.ts` | 15min |
| 8 | 单元测试 | `tests/unit/server/heartbeat-health.test.ts` | 30min |
| 9 | 集成测试 | `tests/integration/heartbeat-state-machine.test.ts` | 30min |
| 10 | E2E 测试 | `tests/e2e/mailbox-control-flow.test.ts` | 30min |

---

## 验收标准

**每个场景必须有测试覆盖**：

| 场景 | 验收标准 |
|------|----------|
| **mailbox 堆积** | pending > 50 时进入 DEGRADED，写入 Ledger，降低心跳频率 |
| **mailbox 卡死** | processing age > 30min 时进入 PAUSED，写入 Ledger，停止写入 |
| **Agent 停止请求** | stop_heartbeat() 后状态变 STOPPED，写入 Ledger，不再写入 mailbox |
| **mailbox 清理** | mailbox_clear(completed) 清理已完成消息，返回清理数量 |
| **状态恢复** | resume_heartbeat() 恢复 PAUSED → RUNNING，写入 Ledger |
| **健康检测** | 每轮心跳检测 mailbox 健康，写入 Ledger |
| **错误记录** | 所有事件写入 Ledger，severity 正确 |
| **Agent 感知** | inject prompt 包含 mailbox 健康和可用工具说明 |

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

## 去重判断标准（Agent 参考）

Agent 检测重复消息时，使用以下判断标准：

### 1. 精确去重

**定义**：title + timestamp 完全相同

**检测逻辑**：
```
scan mailbox.list()
→ 发现两条消息 title 相同 + timestamp 相差 < 1s
→ 标记为精确重复
```

**示例**：
- msg-1: `[System][Heartbeat] Periodic Health Check` @ 2026-03-22T10:00:00Z
- msg-2: `[System][Heartbeat] Periodic Health Check` @ 2026-03-22T10:00:01Z
- 判断：精确重复 → `mailbox_mark_skip(ids=["msg-2"], reason="精确重复")`

### 2. 近似去重

**定义**：title 相同 + 时间间隔 < 5min

**检测逻辑**：
```
scan mailbox.list()
→ 发现两条消息 title 相同 + timestamp 相差 < 5min
→ 标记为近似重复（可能是系统重复写入）
```

**示例**：
- msg-1: `[System][Heartbeat] Periodic Health Check` @ 2026-03-22T10:00:00Z
- msg-2: `[System][Heartbeat] Periodic Health Check` @ 2026-03-22T10:03:00Z
- 判断：近似重复 → `mailbox_mark_skip(ids=["msg-2"], reason="近似重复，间隔3min")`

### 3. 心跳序号去重

**定义**：`[System][Heartbeat] seq=123` 多次出现

**检测逻辑**：
```
scan mailbox.list()
→ 发现多条消息包含相同 seq number
→ 提取 seq from title/payload
→ 标记序号重复
```

**示例**：
- msg-1: `[System][Heartbeat] seq=123` @ 2026-03-22T10:00:00Z
- msg-2: `[System][Heartbeat] seq=123` @ 2026-03-22T10:02:00Z
- 判断：序号重复 → `mailbox_mark_skip(ids=["msg-2"], reason="心跳序号123重复")`

### 4. 内容相似度去重（可选）

**定义**：payload 内容相似度 > 90%

**检测逻辑**：
```
read mailbox.read(msg-1) + mailbox.read(msg-2)
→ 比较 payload 内容
→ 若相似度 > 90% → 标记为内容重复
```

**示例**：
- msg-1 payload: `{"task": "health_check", "seq": 123, "status": "running"}`
- msg-2 payload: `{"task": "health_check", "seq": 123, "status": "running"}`
- 判断：内容相似度 100% → `mailbox_mark_skip(ids=["msg-2"], reason="内容完全相同")`

### 去重优先级

| 去重类型 | 优先级 | 适用场景 |
|----------|--------|----------|
| **精确去重** | P0 | 系统重复写入同一消息 |
| **近似去重** | P0 | 心跳间隔内重复触发 |
| **序号去重** | P1 | 心跳序号重复写入 |
| **内容相似度** | P2 | 复杂场景辅助判断 |

---

## 变更记录
| 日期 | 变更 |
|------|------|
| 2026-03-22 | 初版设计，定义优先级与三段式格式 |
| 2026-03-23 | 新增 `mailbox.read_all` / `mailbox.remove_all`，补充 notification idle-only 与批量处理规则 |
| 2026-03-23 | Mailbox 改为内存态不持久化；`mailbox.ack` 成功后自动清理消息 |
| 2026-04-06 | **重大修正**：基于 Agent-driven 异步执行模式重新设计 |
| 2026-04-06 | 新增心跳状态机、错误分级、容错设计、控制接口、Kernel Tools、Ledger 审计追踪 |
| 2026-04-06 | 超时检测改为 mailbox 状态健康检测（堆积/卡死） |
| 2026-04-06 | 状态机基于 mailbox 健康而非 dispatch timeout |
| 2026-04-06 | 明确 Agent 能力边界：请求而非强制干预 |
| 2026-04-06 | 新增 Agent 能力边界表、执行模式说明、健康检测参数 |
