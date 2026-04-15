# Context Ledger / Memory / Digest 设计（唯一真源）

> **版本**: v2.0  
> **最后更新**: 2026-04-12  
> **状态**: 权威设计文档，所有实现必须遵循本文档  
> **适用范围**: session ledger、compact memory、digest 生成、心跳 session、周期性任务

---

## 一、架构总览

### 1.1 三层存储模型

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Context Ledger（流水层）                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │ context-ledger.jsonl                               │  │
│  │ - 每条 message 都记录（user/assistant/tool_call/   │  │
│  │   tool_result/session_message）                    │  │
│  │ - 不可变追加写入（append-only）                     │  │
│  │ - 按 session 隔离：                                │  │
│  │   ~/.finger/sessions/<sessionId>/                  │  │
│  │     <agentId>/<mode>/context-ledger.jsonl          │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Compact Memory（摘要层）                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │ compact-memory.jsonl                               │  │
│  │ - 任务完成后生成 digest                            │  │
│  │ - 包含: summary, tags, key_tools, tool_calls       │  │
│  │ - 用于 context rebuild 时的历史回溯                │  │
│  │ - 按 session 隔离（与 ledger 同目录）               │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Project Memory（记忆层）                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │ MEMORY.md（项目级长期/短期记忆）                     │  │
│  │ - 由 control block 的 learning 写入                │  │
│  │ - 跨 session 持久化                                │  │
│  │ - 按项目隔离                                       │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 1.2 数据流向

```
用户输入 prompt
    ↓
Model 响应（包含 finger-control JSON block）
    ↓
┌─────────────────────────────────────────────────┐
│ Control Block 解析（kernel-agent-base.ts）        │
│                                                   │
│ finger-control {                                  │
│   tags: [...],           ← 用于 digest            │
│   learning: {            ← 用于 memory            │
│     long_term_items: [],                          │
│     short_term_items: [],                         │
│     flow_patch: {...},                            │
│     user_profile_patch: {...}                     │
│   }                                               │
│ }                                                 │
└─────────────────────────────────────────────────┘
         ↓                              ↓
   ┌─────┴──────┐              ┌────────┴────────┐
   │ tags 写入   │              │ learning 写入    │
   │ digest 层   │              │ MEMORY.md       │
   │ compact-   │              │（长期/短期记忆）  │
   │ memory     │              │                 │
   └────────────┘              └─────────────────┘
```

---

## 二、正常 Session 的 Ledger/Memory/Digest 流程

### 2.1 Ledger 流水（Layer 1）

**写入时机**：每次 turn 完成后追加

**写入内容**：
```json
{
  "id": "led-{timestamp}-{random}",
  "timestamp_ms": 1775965338816,
  "timestamp_iso": "2026-04-12T03:42:18.816Z",
  "session_id": "...",
  "agent_id": "...",
  "mode": "main",
  "event_type": "session_message | tool_call | tool_result | assistant | user",
  "payload": { "role": "...", "content": "...", "token_count": N, "message_id": "..." }
}
```

**写入位置**：`~/.finger/sessions/<sessionId>/<agentId>/<mode>/context-ledger.jsonl`

### 2.2 Control Block 处理

**模型响应要求**：每个 turn 必须包含 `finger-control` JSON block

**tags 处理**（`chat-codex-module.ts:1858`）：
```typescript
// finish_reason = stop 时
const tags = controlParsed.controlBlock?.tags || [];
await digestProvider(sessionId, digestMessage, tags, agentId, mode);
```

**learning 处理**（待实现）：
```typescript
// 当前：只解析，未写入 memory
// 应该：提取 learning.memory_patch 后写入 MEMORY.md
const learning = controlParsed.controlBlock?.learning;
if (learning?.memory_patch?.required) {
  await writeMemoryPatch(learning.memory_patch);
}
```

### 2.3 Digest 生成（Layer 2）

**触发时机**：
1. `finish_reason = stop` 时自动生成
2. `context_history.rebuild` 手动触发

**Digest 格式**：
```json
{
  "agent_id": "finger-project-agent",
  "id": "cpt-{timestamp}-{random}",
  "mode": "main",
  "payload": {
    "algorithm": "task_digest_v2",
    "summary": "...",
    "tags": ["dispatch", "build", "test"],
    "topic": "fix dispatch timeout",
    "key_tools": ["agent.dispatch", "patch", "exec_command"],
    "tool_calls": [
      {
        "tool": "agent.dispatch",
        "status": "success",
        "input": "...",
        "output": "..."
      }
    ],
    "compressed_at_ms": 1775965338816,
    "compressed_at_iso": "2026-04-12T03:42:18.816Z"
  },
  "role": "project",
  "session_id": "...",
  "timestamp_iso": "2026-04-12T03:42:18.816Z",
  "timestamp_ms": 1775965338816
}
```

**Digest 重要工具白名单**（只保留以下工具的调用记录）：
```typescript
const DIGEST_IMPORTANT_TOOLS = new Set([
  // 任务派发与协调
  'agent.dispatch', 'agent.capabilities',
  // 任务规划与完成
  'update_plan', 'reasoning.stop', 'report-task-completion',
  // 代码修改
  'patch',
  // 邮箱与消息
  'mailbox.status', 'mailbox.dequeue', 'mailbox.enqueue',
  // 上下文与Ledger
  'context_history.rebuild', 'context_ledger.digest', 'context_ledger.query',
  // 项目管理
  'project.task.status', 'project.task.update',
  // Agent协作
  'agent.collab.ask', 'agent.collab.tell', 'agent.collab.broadcast',
]);
```

所有不在白名单中的工具调用（如 `exec_command`、`view_file`、`read_file`、`grep`、`cat /dev/null` 等查询/读取操作）**不记录在 digest 中**。

### 2.4 Tags 继承规则

**Digest 的 tags 来源**：只从 finish turn（`reasoning.stop`）的 control block 提取

```
reasoning.stop input: {
  "tags": ["build", "rust", "multi-protocol"],
  "summary": "...",
  "goal": "..."
}
→ TaskDigestEntry.tags = ["build", "rust", "multi-protocol"]
```

**Topic 来源**：从 assistant message metadata 提取
```
metadata: {
  "topic": "fix dispatch timeout",
  "tags": ["dispatch", "timeout"]
}
```

---

## 三、心跳 Session 规则（特殊处理）

### 3.1 心跳 Session 不保存 Ledger / Digest

**规则**：
1. ❌ 心跳 session **不写** context-ledger.jsonl
2. ❌ 心跳 session **不写** compact-memory.jsonl
3. ❌ 心跳 session **不生成** digest
4. ✅ 心跳 session **只做**状态检查和通知

### 3.2 心跳简化流程

```
心跳 tick（定时触发）
    ↓
检查 Agent 状态（runtime_view）
    ↓
├── Agent 状态 = working / processing
│   → 静默，不干扰
│
├── Agent 状态 = idle
│   ├── 有未完成的任务（projectTaskRegistry 查询）
│   │   → 通知 Agent 继续执行（不启动新 session）
│   └── 无任务
│       → 保持 idle
│
└── Agent 不在线 / 未响应
    → 标记异常，不触发恢复
```

### 3.3 心跳不触发 Session

**关键变更**：
- 心跳**不应创建独立的 session**（当前有 `hb-session-finger-system-agent-global` 需要清理）
- 心跳**直接通知 Agent**，通过已有 session 的 mailbox 或 dispatch 机制
- 心跳**不触发 LLM 调用**，只做状态判断

### 3.4 实现标记

```typescript
// session 级别标记：心跳 session 跳过所有持久化
interface SessionConfig {
  isHeartbeatSession: boolean;  // true → skip ledger, skip digest
  // ...
}

// 在 ledger 写入时检查
if (session.config?.isHeartbeatSession) {
  return; // 跳过写入
}

// 在 digest 生成时检查
if (context.sessionType === 'heartbeat') {
  return; // 跳过 digest
}
```

---

## 四、周期性任务（Periodic Tasks）

### 4.1 独立 Ledger 和 Session

**规则**：
1. ✅ 每个周期性任务有**独立的 ledger**（periodic-task-ledger.jsonl）
2. ✅ 每个周期性任务有**独立的 session**（不与主 session 混合）
3. ❌ 周期性任务 ledger **不保存**系统自检和初始化 slot
4. ✅ 只记录**正式执行任务的记录**

### 4.2 周期性任务记录内容

**只记录**：
```json
{
  "id": "periodic-{timestamp}-{taskId}",
  "task_type": "news_aggregation",
  "start_time": "2026-04-12T10:00:00Z",
  "end_time": "2026-04-12T10:05:00Z",
  "digest": {
    "summary": "Aggregated 15 news articles from 3 sources",
    "status": "success",
    "items_processed": 15,
    "errors": []
  }
}
```

**不记录**：
- ❌ 工具调用过程（不记录 exec_command、read_file 等）
- ❌ 中间步骤的详细日志
- ❌ 系统自检信息
- ❌ 初始化 slot

### 4.3 存储位置

```
~/.finger/runtime/periodic-tasks/
├── news-aggregation/
│   ├── periodic-task-ledger.jsonl
│   └── session.json
├── health-check/
│   ├── periodic-task-ledger.jsonl
│   └── session.json
└── ...
```

### 4.4 实现标记

```typescript
// 周期性任务 ledger 写入
async function writePeriodicTaskLedger(taskId: string, entry: PeriodicTaskEntry): Promise<void> {
  // 只写入 digest，不写入工具调用
  const path = resolvePeriodicTaskLedgerPath(taskId);
  await appendJsonl(path, {
    ...entry,
    tool_calls: undefined,  // 不记录工具调用
    original: undefined,    // 不保留原文
  });
}
```

---

## 五、Memory 写入（Learning 持久化）

### 5.1 Control Block Learning 提取

```typescript
interface ControlBlockLearning {
  did_right: string[];          // 做得好的
  did_wrong: string[];          // 做错的
  repeated_wrong: string[];     // 重复做错的
  flow_patch: {                 // 流程修复
    required: boolean;
    project_scope: string;
    changes: string[];
  };
  memory_patch: {               // 记忆修复
    required: boolean;
    project_scope: string;
    long_term_items: string[];  // 长期记忆条目
    short_term_items: string[]; // 短期记忆条目
  };
  user_profile_patch: {         // 用户偏好修复
    required: boolean;
    items: string[];
    sensitivity: 'normal' | 'sensitive';
  };
}
```

### 5.2 Memory 写入规则

```typescript
async function processLearning(learning: ControlBlockLearning, projectPath: string): Promise<void> {
  // 1. 长期记忆 → MEMORY.md (Long-term Memory)
  if (learning.memory_patch?.long_term_items?.length > 0) {
    await appendToMemoryMd(projectPath, 'long-term', learning.memory_patch.long_term_items);
  }
  
  // 2. 短期记忆 → MEMORY.md (Short-term Memory)
  if (learning.memory_patch?.short_term_items?.length > 0) {
    await appendToMemoryMd(projectPath, 'short-term', learning.memory_patch.short_term_items);
  }
  
  // 3. 用户偏好 → ~/.codex/USER.md
  if (learning.user_profile_patch?.required) {
    await updateUserProfile(learning.user_profile_patch);
  }
  
  // 4. 流程修复 → AGENTS.md 或 SKILL.md
  if (learning.flow_patch?.required) {
    await applyFlowPatch(learning.flow_patch);
  }
}
```

### 5.3 MEMORY.md 格式

```markdown
# MEMORY.md

## Long-term Memory
- {timestamp} - 项目架构决策：使用 Core/Extension 分层
- {timestamp} - 用户偏好：直接执行，不问问题

## Short-term Memory
- {timestamp} - 当前任务：修复 dispatch 超时问题
- {timestamp} - 发现：session 工具注册失败导致 dispatch 排队
```

---

## 六、Context Rebuild 流程

### 6.1 触发条件

```
contextUsagePercent >= 85%
  ↓
触发 compactCurrentHistory()
```

### 6.2 Compact 流程

```
1. 识别所有 task（从 reasoning.stop 到 reasoning.stop）
2. 为每个 task 生成 digest
3. digest 写入 compact-memory.jsonl
4. 保留最近 N 条 raw messages（工作集）
5. 其他历史替换为 digest
```

### 6.3 Rebuild 流程（Context 重建）

```
1. 获取当前用户 prompt
2. 从 compact-memory.jsonl 读取所有 digest
3. LLM 提取相关 tags（可选，或使用 embedding 召回）
4. 根据 tags 过滤相关 digest
5. 时间从新到旧，在 token budget 内填充
6. 注入 Initial Context（提示词、AGENTS.md 等）
7. 返回重建后的 context
```

---

## 七、文件结构

```
~/.finger/sessions/<sessionId>/<agentId>/<mode>/
├── context-ledger.jsonl          # Layer 1: 完整流水
├── compact-memory.jsonl          # Layer 2: 任务摘要
├── compact-memory-index.json     # digest 索引
└── main.json                     # session 状态（context、projectTaskState 等）

~/.finger/runtime/periodic-tasks/<taskId>/
├── periodic-task-ledger.jsonl    # 周期性任务 ledger
└── session.json                  # 周期性任务 session 状态

<ProjectRoot>/
└── MEMORY.md                     # Layer 3: 项目记忆
```

---

## 八、实现清单

| # | 任务 | 状态 | 文件 |
|---|------|------|------|
| 1 | Learning 写入 MEMORY.md | ❌ 待实现 | `kernel-agent-base.ts` |
| 2 | 心跳 session 跳过 ledger | ❌ 待实现 | `heartbeat-scheduler.impl.ts` |
| 3 | 心跳 session 跳过 digest | ❌ 待实现 | `context-ledger-memory.ts` |
| 4 | 清理残留心跳 session | ❌ 待实现 | 启动清理逻辑 |
| 5 | 周期性任务独立 ledger | ❌ 待实现 | `context-ledger-memory.ts` |
| 6 | 周期性任务只记录摘要 | ❌ 待实现 | `context-ledger-memory.ts` |
| 7 | Digest 重要工具白名单 | ✅ 已实现 | `context-ledger-memory.ts` |
| 8 | Tags 从 control block 提取 | ✅ 已实现 | `chat-codex-module.ts` |
