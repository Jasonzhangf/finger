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

## 版本历史

- 2026-03-14: 初始设计，Phase 1 完成
