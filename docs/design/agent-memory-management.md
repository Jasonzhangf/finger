# Agent 记忆管理与 Reviewer 流程设计

## 概述

实现双层记忆管理（CACHE.md + MEMORY.md）与 Reviewer 流程集成，提供 Agent 生命周期中的自动记忆跟踪与质量保证机制。

## 核心目标

1. **短期记忆（CACHE.md）**：自动记录所有 Agent 请求与返回
2. **长期记忆（MEMORY.md）**：Reviewer approve 后总结并持久化
3. **Reviewer 流程**：扩展现有 FSM reviewer，支持 executor 结果评审
4. **自动清理**：Reviewer approve 时自动 CACHE → MEMORY 总结

## 架构设计

### 1. 双层记忆系统

```
┌─────────────────────────────────────────────────────────┐
│                    Agent 生命周期                         │
├─────────────────────────────────────────────────────────┤
│  用户请求 → CACHE.md 拦截写入                            │
│  Agent 执行                                               │
│  finish_reason=stop → CACHE.md 拦截写入                   │
│  Reviewer approve → CACHE → MEMORY 总结 + 清理            │
└─────────────────────────────────────────────────────────┘
```

### 2. CACHE.md 结构

```markdown
# Conversation Cache

### USER REQUEST
**Time**: 2026-03-14T06:20:00Z
**Agent**: finger-orchestrator
**Session**: session-1

请继续推进 finger-214.7.3 ModuleRegistry 强化

**Summary**: 请继续推进 finger-214.7.3 ModuleRegistry 强化

---

### ASSISTANT RESPONSE
**Time**: 2026-03-14T06:25:00Z
**Agent**: finger-orchestrator
**Session**: session-1
**Finish Reason**: stop

已完成 ModuleRegistry 健康检查实现...

**Summary**: 已完成 ModuleRegistry 健康检查实现

---
```

### 3. Reviewer 流程扩展

```
┌─────────────────────────────────────────────────────────┐
│              Orchestrator FSM Reviewer 扩展              │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  dispatch → executor 执行                                 │
│       ↓                                                   │
│  executor 返回结果                                        │
│       ↓                                                   │
│  reviewer 审计（独立 agent + 独立 session）              │
│       ↓                                                   │
│  ┌─────────────┐                                         │
│  │ 不通过      │ → 直接反馈给 executor（继续修正）         │
│  └─────────────┘                                         │
│       ↓                                                   │
│  ┌─────────────┐                                         │
│  │ 通过        │ → 触发 CACHE → MEMORY 总结               │
│  └─────────────┘                                         │
│       ↓                                                   │
│  返回 orchestrator                                        │
└─────────────────────────────────────────────────────────┘
```

## 实现细节

### Phase 1: CACHE.md 拦截机制 ✅

**已完成**：
- `CacheMemoryInterceptor` 类：拦截用户请求与 assistant 返回
- `cache-memory-tool.ts`：CACHE.md 管理（insert/compact/clear）
- 集成到 `kernel-agent-base.ts`：自动拦截
- 测试验证通过（8/8 passed）

**写入触发点**：
```typescript
// 用户请求
await this.cacheMemoryInterceptor.interceptRequest(input);

// assistant 返回（finish_reason=stop）
await this.cacheMemoryInterceptor.interceptResponse(output, input);
```

### Phase 2: Memory Tool 扩展（进行中）

**目标**：扩展 memory tool 支持 CACHE.md

- 新增 `target: 'cache' | 'memory'` 参数
- `insert` 默认写入 CACHE.md
- `compact` 实现 CACHE → MEMORY 总结
- 清理逻辑：清空 CACHE.md，写入摘要残留

### Phase 3: Reviewer 流程扩展

**目标**：扩展现有 orchestrator-fsm-v2 reviewer

**dispatch 结构扩展**：
```typescript
interface DispatchOptions {
  reviewer?: {
    agentId: string;
    goal: string;
    criteria?: string[];
  };
}
```

**FSM 状态扩展**：
- 新增 `review_executor` 状态
- 支持 executor 结果评审
- 不通��� → 反馈给 executor
- 通过 → 触发 compact

### Phase 4: 自动总结机制

**触发条件**：
1. Reviewer approve（自动）
2. 手动 compact（保留）

**总结格式**：
```markdown
## [summary] CACHE Summary - 2026-03-14T06:30:00Z

**Total entries**: 15
**Duration**: 10 minutes
**Reviewer outcome**: approved

### Key Activities
- [user] 请求：继续推进 finger-214.7.3
- [assistant] 响应：完成健康检查实现
- [reviewer] 审批：通过

### Learnings
- 健康检查机制已验证
- 测试覆盖完整（23/23 passed）
```

## 技术约束

1. **兼容性**：保持现有 memory tool 接口兼容
2. **性能**：CACHE 写入异步，不阻塞 agent 执行
3. **可靠性**：memory tool 失败不影响 agent 主流程
4. **可观测性**：写入失败时记录日志

## 验收标准

### Phase 1 ✅
- [x] CacheMemoryInterceptor 实现
- [x] cache-memory-tool.ts 实现
- [x] 集成到 kernel-agent-base.ts
- [x] 测试通过（8/8）

### Phase 2（进行中）
- [ ] memory tool 扩展 target 参数
- [ ] CACHE.md 默认写入路径
- [ ] compact 实现总结+清理
- [ ] 测试验证

### Phase 3
- [ ] orchestrator-fsm-v2 扩展
- [ ] dispatch reviewer 选项
- [ ] reviewer 状态机
- [ ] 反馈机制实现
- [ ] 测试验证

### Phase 4
- [ ] 自动总结触发
- [ ] MEMORY.md 写入格式
- [ ] CACHE.md 清理
- [ ] 残留记忆保留
- [ ] 端到端测试

## 文件变更

### 新增文件
- `src/agents/base/cache-memory-interceptor.ts`
- `src/tools/internal/memory/cache-memory-tool.ts`
- `tests/unit/agents/cache-memory-interceptor.test.ts`
- `docs/design/agent-memory-management.md`

### 修改文件
- `src/agents/base/kernel-agent-base.ts`
- `src/orchestration/orchestrator-fsm-v2.ts`（待修改）
- `src/tools/internal/memory/memory-tool.ts`（待修改）

## 依赖关系

```
finger-236 (Epic)
├── finger-236.1: Phase 1 - CACHE.md 拦截机制 ✅
├── finger-236.2: Phase 2 - Memory Tool 扩展 (IN_PROGRESS)
├── finger-236.3: Phase 3 - Reviewer 流程扩展 (BLOCKED by 236.2)
└── finger-236.4: Phase 4 - 自动总结机制 (BLOCKED by 236.3)
```

## 参考资料

- 现有 memory tool: `src/tools/internal/memory/memory-tool.ts`
- Context Ledger Memory: `src/runtime/context-ledger-memory.ts`
- Orchestrator FSM: `src/orchestration/orchestrator-fsm-v2.ts`
- Kernel Agent Base: `src/agents/base/kernel-agent-base.ts`


## Session 完整上下文：Reasoning 持久化 + Ledger Pointer 注入

### 概述

为确保 Agent 的思考过程和执行历史能够被完整保留并在下一轮对话中使用，实现了以下机制：

1. **Reasoning 持久化**：模型的思考过程以 `assistant` 角色存储到 session
2. **Ledger Pointer 注入**：自动注入主 session 和子 session 的 ledger 指针

### Reasoning 持久化

**问题背景**：
- Reasoning（思考过程）原本以 `system` role 存储
- `system` role 的消息在构建 kernel history 时会被跳过或转换
- 导致下一轮对话丢失之前的思考上下文

**解决方案**：
```typescript
// src/server/modules/event-forwarding.ts
// Reasoning 以 assistant role 存储，包含 agent 和 role 信息
persistSessionEventMessage(
  event.sessionId,
  `[role=${roleProfile} agent=${agentId}] 思考: ${reasoningText}`,
  {
    type: 'reasoning',
    agentId,
    metadata: { role: roleProfile, agentId, fullReasoningText: reasoningText },
  },
  'assistant', // 使用 assistant role，确保被包含在 kernel history 中
);
```

**Content 格式**：
```
[role=orchestrator agent=finger-orchestrator] 思考: Let me analyze the code structure...
```

**关键字段**：
- `role`: `assistant`（确保被 kernel history 包含）
- `type`: `reasoning`（便于过滤和识别）
- `metadata.role`: 角色 profile（orchestrator/reviewer/executor 等）
- `metadata.agentId`: 发射 reasoning 的 agent ID
- `metadata.fullReasoningText`: 完整的 reasoning 文本（无截断）

### Ledger Pointer 注入

**问题背景**：
- Agent 执行过程中的上下文存储在 ledger 中
- 下一轮对话需要能够追溯到之前的 ledger
- 模型容易忘记或不知道 ledger 的位置

**解决方案**：自动注入 ledger pointer 到 session

#### 1. 主 Session Ledger Pointer（turn_start）

当 `turn_start` 事件发生时，自动注入主 session 的 ledger pointer：

```typescript
// src/server/modules/event-forwarding.ts
if (event.phase === 'turn_start') {
  addLedgerPointerMessage(event.sessionId, 'main', generalAgentId);
}
```

**格式**：
```
[ledger_pointer:main] session=session-xxx agent=finger-orchestrator mode=main root=~/.finger path=~/.finger/sessions/.../context-ledger.jsonl
```

#### 2. 子 Session Ledger Pointer（dispatch completed/failed）

当 dispatch 完成（`completed` 或 `failed`）时，自动注入子 session 的 ledger pointer：

```typescript
// src/server/modules/event-forwarding.ts
if ((status === 'completed' || status === 'failed') && sessionId) {
  const childSessionId = asString(payload.childSessionId)
    ?? (isObjectRecord(payload.result)
      ? asString(payload.result.childSessionId)
        ?? asString(payload.result.sessionId)
      : undefined);
  if (childSessionId) {
    addLedgerPointerMessage(sessionId, `child:${childSessionId}`, targetAgentId);
  }
}
```

**childSessionId 来源**：
1. `payload.childSessionId`（直接指定）
2. `payload.result.childSessionId`（从 dispatch 结果中提取）
3. `payload.result.sessionId`（sanitizeDispatchResult 映射后的字段）

#### 3. 去重机制

防止重复注入相同的 ledger pointer：

```typescript
const hasLedgerPointerMessage = (sessionId: string, label: string): boolean => {
  const messages = sessionManager.getMessages(sessionId, 0);
  return messages.some((message) => message.type === 'ledger_pointer'
    && message.metadata?.ledgerPointer?.label === label);
};
```

### 数据流

```
┌─────────────────────────────────────────────────────────┐
│                   Session 上下文构建                      │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  turn_start                                               │
│       ↓                                                   │
│  注入 main ledger pointer                                │
│       ↓                                                   │
│  reasoning 事件 → 以 assistant role 存储到 session       │
│       ↓                                                   │
│  tool_call/tool_result 等事件存储                        │
│       ↓                                                   │
│  dispatch → 子 agent 执行                                │
│       ↓                                                   │
│  dispatch completed/failed                               │
│       ↓                                                   │
│  注入 child ledger pointer                               │
│       ↓                                                   │
│  下一轮对话：session messages + ledger pointers          │
│       ↓                                                   │
│  kernel history 包含完整上下文                           │
└─────────────────────────────────────────────────────────┘
```

### 测试覆盖

**文件**：
- `tests/modules/event-forwarding.test.ts`（12 tests）
- `tests/modules/event-forwarding-helpers.test.ts`（15 tests）

**测试用例**：
1. Reasoning 以 assistant role 存储
2. Reasoning 包含 agentId 和 roleProfile
3. 使用默认值填充缺失的 agentId/roleProfile
4. 不存储空的 reasoning
5. turn_start 注入 main ledger pointer
6. 去重不重复注入
7. dispatch completed 注入 child ledger pointer（payload.childSessionId）
8. dispatch completed 注入 child ledger pointer（result.sessionId）
9. dispatch failed 注入 child ledger pointer
10. queued 状态不注入 ledger pointer
11. 子 session ledger pointer 去重
12. payload.childSessionId 为空时从 result.childSessionId 注入（含 metadata.label 断言）

### 相关文件

- `src/server/modules/event-forwarding.ts` - 事件转发和 session 持久化
- `src/server/modules/event-forwarding-helpers.ts` - helper 函数
- `src/agents/chat-codex/chat-codex-module.ts` - reasoning 事件发射
- `src/orchestration/session-manager.ts` - session 消息类型定义


## 版本历史

- 2026-03-14: 初始设计，Phase 1 完成
- 2026-03-21: 新增 Session 完整上下文设计（Reasoning 持久化 + Ledger Pointer 注入）
