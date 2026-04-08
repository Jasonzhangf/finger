# Context Ledger Task-Digest 设计

## 概述

本文档定义 Context Ledger 的 Task-Digest 两层格式，用于高效上下文重建。

---

## 核心概念

### Task 定义

- **Task** = 从用户请求到 reasoning.stop 之间的所有 turns
- **Turn** = 一个 kernel round（model_round + tool_calls + tool_results）
- **Task boundary** = reasoning.stop 工具调用

### 两层格式

每个 task entry 同时存储：
1. **original**：完整原文（保留但不发送给 LLM）
2. **digest**：压缩摘要（发送给 LLM）

---

## 数据结构

### TaskDigestEntry（ledger entry）

```typescript
interface TaskDigestEntry {
  id: string;                          // task-{timestamp}-{random}
  timestamp_start: string;             // task 开始时间
  timestamp_end: string;               // task 结束时间（reasoning.stop）
  session_id: string;
  agent_id: string;
  mode: string;
  event_type: 'task_digest';
  
  // Tags：只从 finish turn（reasoning.stop）提取
  tags: string[];
  
  // 两层格式
  original: {
    turns: TurnEntry[];                // 完整原文
    total_bytes: number;
  };
  
  digest: {
    goal: string;                      // 用户原始请求
    result: string;                    // 最终结果摘要
    key_turns: KeyTurn[];              // 关键工具调用
    changed_files: string[];           // 变更文件列表
    outcome: 'success' | 'failed' | 'rejected';
    estimated_tokens: number;          // digest token 估算
  };
}
```

### KeyTurn（关键工具调用）

```typescript
interface KeyTurn {
  tool: string;                        // 工具名称
  timestamp: string;
  summary: string;                     // 工具输出摘要
  target?: string;                     // agent.dispatch 的目标 agent
  outcome?: string;                    // approve/reject 的结果
}
```

**Key tools 白名单**：

| 工具 | 含义 |
|------|------|
| `reasoning.stop` | 任务结束点 |
| `agent.dispatch` | 派发子任务 |
| `project.claim_completion` | 提交完成声明 |
| `project.approve_task` | 验收通过 |
| `project.reject_task` | 验收拒绝 |

---

## Tags 继承规则

**Task 的 tags 只看 finish turn（reasoning.stop）的 tags**。

```typescript
// reasoning.stop input 包含 tags
{
  "tags": ["build", "rust", "multi-protocol"],
  "summary": "...",
  "goal": "...",
  ...
}

// TaskDigestEntry.tags = reasoning.stop input.tags
```

---

## Context Rebuild 流程

### 触发条件

```text
contextUsagePercent >= 85%
  ↓
触发 compactCurrentHistory()
```

### Compact 流程

```typescript
async function compactCurrentHistory(session: Session): Promise<void> {
  // 1. 把 current history 中所有 task 压缩成 digest
  const tasks = identifyTasks(currentHistory);
  
  // 2. 为每个 task 生成 TaskDigestEntry
  for (const task of tasks) {
    const entry = {
      id: `task-${task.timestamp_start}`,
      tags: task.finishTurn.reasoningStop.input.tags,
      original: { turns: task.turns, total_bytes: ... },
      digest: {
        goal: task.firstTurn.userMessage,
        result: task.finishTurn.reasoningStop.input.summary,
        key_turns: extractKeyTurns(task),
        changed_files: extractChangedFiles(task),
        outcome: determineOutcome(task),
        estimated_tokens: estimateDigestTokens(digest),
      },
    };
    await appendToLedger(entry);
  }
  
  // 3. 更新全局 tag 表
  updateGlobalTagTable(tasks);
  
  // 4. current history 归零
  resetCurrentHistory(session);
}
```

### Rebuild 流程

```typescript
async function rebuildContextHistory(
  digests: TaskDigestEntry[],
  currentUserMessage: string,
  globalTagTable: string[],
  budget: number = 20000
): Promise<TaskDigestEntry[]> {
  
  // Step 1: LLM 挑选最相关 tags
  const relevantTags = await pickRelevantTags(currentUserMessage, globalTagTable);
  
  // Step 2: 根据 tags 过滤
  const filtered = digests.filter(d => 
    d.tags.some(t => relevantTags.includes(t))
  );
  
  // Step 3: 时间从新到旧，20K 预算内填充
  const selected: TaskDigestEntry[] = [];
  let tokens = 0;
  
  for (const d of filtered.reverse()) {
    if (tokens + d.digest.estimated_tokens > budget) break;
    selected.push(d);
    tokens += d.digest.estimated_tokens;
  }
  
  return selected;
}
```

---

## Ledger 补全工具

### 用途

把已有的 ledger 补成两层格式（original + digest）。

### 实现步骤

```typescript
async function backfillLedger(ledgerPath: string): Promise<void> {
  // 1. 读取所有 entries
  const entries = await readJsonLines(ledgerPath);
  
  // 2. 识别 task boundaries
  const tasks = identifyTasks(entries);
  
  // 3. 为每个 task 生成 TaskDigestEntry
  for (const task of tasks) {
    const finishTurn = findFinishTurn(task);
    const tags = finishTurn?.payload?.input?.tags || [];
    
    const entry: TaskDigestEntry = {
      id: `task-${task.timestamp_start}`,
      timestamp_start: task.start.timestamp_iso,
      timestamp_end: task.end.timestamp_iso,
      session_id: task.session_id,
      agent_id: task.agent_id,
      mode: task.mode,
      event_type: 'task_digest',
      tags,
      original: {
        turns: task.turns,
        total_bytes: calculateTotalBytes(task.turns),
      },
      digest: buildDigest(task),
    };
    
    await appendTaskDigest(ledgerPath, entry);
  }
}
```

---

## 压缩效果

基于实际数据分析：

| 指标 | 原始 | Digest 后 |
|------|------|----------|
| Task 平均大小 | 78k-176k bytes | ~1kb |
| 压缩比 | - | **73x** |
| 20K 预算容纳 | 0.1 task | ~20 task digests |

---

## 实施顺序

| 步骤 | 内容 | 时间 |
|------|------|------|
| 1 | 定义 TaskDigestEntry 类型 | 0.5d |
| 2 | 实现 Ledger 补全工具 | 1d |
| 3 | 修改 compactCurrentHistory | 1d |
| 4 | 实现 tag-based rebuild | 1d |
| 5 | 验证压缩比 + rebuild 效果 | 0.5d |

---

## 相关文件

- `src/runtime/context-history-compact.ts`：现有 compact 实现
- `src/runtime/context-ledger-memory-types.ts`：ledger 类型定义
- `src/runtime/context-builder.ts`：context rebuild 实现
- `docs/design/chat-codex-prompt-contract.md`：prompt 契约

---

## 变更历史

- 2026-04-08：初始设计，定义 Task-level digest + 两层格式
