# Context Compact 状态机设计

> 状态：设计完成，待实施
> 创建时间：2026-04-07
> 问题：当前实现缺少状态机，导致压缩后指针混乱，Kernel 无法正确加载

---

## 1. 问题陈述

### 1.1 当前症状

```
日志显示：
[appendDigestForTurn] Turn digest appended
  → sourceSlotStart: 51, sourceSlotEnd: 0, previousCompactedSlotEnd: 50

问题：
- sourceSlotStart (51) > sourceSlotEnd (0) ← 指针倒置！
- Kernel 仍显示 96% 上下文占用
- compact-memory.jsonl 有数据，但 Kernel 不识别
```

### 1.2 根本原因

**当前实现没有状态机**，导致：

1. **Digest 写入** 和 **指针更新** 是分离的
2. **没有原子性保证**：digest 写入了，指针可能没更新
3. **没有状态验证**：指针倒置也没人管
4. **Kernel 重建** 没有触发：压缩完成后 Kernel 不知道要重新加载

---

## 2. 正确的状态机设计

### 2.1 状态定义

```
┌─────────────────────────────────────────────────────────────────┐
│                    Context Compact 状态机                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  IDLE ──[model_round + 85%]──► PENDING                          │
│                                                                  │
│  PENDING ──[cooldown check]──► COOLDOWN_SKIP (返回 IDLE)        │
│          ──[cooldown ok]──► COMPACTING                          │
│                                                                  │
│  COMPACTING ──[生成 digest]──► WRITING_DIGEST                   │
│                                                                  │
│  WRITING_DIGEST ──[写入完成]──► UPDATING_POINTERS               │
│                                                                  │
│  UPDATING_POINTERS ──[指针更新完成]──► NOTIFY_KERNEL            │
│                                                                  │
│  NOTIFY_KERNEL ──[emit session_compressed]──► IDLE              │
│                                                                  │
│  任何状态 ──[error]──► FAILED ──[超时/重试]──► IDLE             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 状态详解

| 状态 | 触发条件 | 执行动作 | 退出条件 |
|------|----------|----------|----------|
| **IDLE** | 初始状态 | 等待 model_round 事件 | contextUsagePercent >= 85% |
| **PENDING** | 收到 model_round + 85% | 检查 cooldown | cooldown ok → COMPACTING |
| **COMPACTING** | cooldown 检查通过 | 读取 currentHistory，生成 digest | digest 生成完成 → WRITING_DIGEST |
| **WRITING_DIGEST** | digest 生成完成 | appendLedgerEvent(compact-memory.jsonl) | 写入完成 → UPDATING_POINTERS |
| **UPDATING_POINTERS** | digest 写入完成 | 更新 Session 指针 | 指针更新完成 → NOTIFY_KERNEL |
| **NOTIFY_KERNEL** | 指针更新完成 | emit('session_compressed') | 事件发出 → IDLE |
| **FAILED** | 任何错误 | 记录错误，不阻塞 | 超时/重试后 → IDLE |

---

### 2.3 指针更新逻辑（关键）

```typescript
// Session 指针结构
interface SessionPointers {
  // Context History (compact-memory.jsonl)
  contextHistoryStart: number;  // 已压缩摘要的起始行号
  contextHistoryEnd: number;    // 已压缩摘要的结束行号
  contextHistoryTokens: number; // 已压缩摘要的 token 数
  
  // Current History (context-ledger.jsonl)
  currentHistoryStart: number;  // 当前历史的起始行号
  currentHistoryEnd: number;    // 当前历史的结束行号
  currentHistoryTokens: number; // 当前历史的 token 数
  
  // 总计
  totalTokens: number;  // contextHistoryTokens + currentHistoryTokens
}

// 压缩后指针更新
function updatePointersAfterCompact(session, newDigestLineNumber, newDigestTokens) {
  // 1. 新 digest 加入 context history
  session.contextHistoryEnd = newDigestLineNumber;
  session.contextHistoryTokens += newDigestTokens;
  
  // 2. current history 清空（指针重置）
  session.currentHistoryStart = session.currentHistoryEnd + 1;
  session.currentHistoryTokens = 0;
  
  // 3. 预算管理：如果 context history 超过 20K，移除最旧的
  while (session.contextHistoryTokens > CONTEXT_HISTORY_BUDGET) {
    const oldestDigest = readCompactMemory(session.contextHistoryStart);
    session.contextHistoryStart++;
    session.contextHistoryTokens -= oldestDigest.tokenCount;
  }
  
  // 4. 更新总计
  session.totalTokens = session.contextHistoryTokens + session.currentHistoryTokens;
  
  // 5. 持久化
  saveSession(session);
}
```

---

### 2.4 Kernel 重建触发

```typescript
// 压缩完成后，通知 Kernel 重新加载上下文
eventBus.emit({
  type: 'session_compressed',
  sessionId: session.id,
  timestamp: Date.now(),
  payload: {
    contextHistoryStart: session.contextHistoryStart,
    contextHistoryEnd: session.contextHistoryEnd,
    currentHistoryStart: session.currentHistoryStart,
    currentHistoryEnd: session.currentHistoryEnd,
    totalTokens: session.totalTokens,
  },
});

// Kernel 端监听 session_compressed 事件
eventBus.on('session_compressed', async (event) => {
  await rebuildContext(event.sessionId);
  // rebuildContext 会读取 compact-memory + context-ledger
  // 使用最新的指针
});
```

---

## 3. 当前实现的问题

### 3.1 缺失的状态检查

```typescript
// 当前代码（有问题）
export async function compressSession(session, options) {
  // ❌ 没有状态检查
  // ❌ 没有原子性保证
  // ❌ 指针更新和 digest 写入分离
  
  const digest = toDeterministicDigest(messages);
  await appendLedgerEvent(compactPath, digest);  // 写入了
  // 但指针可能没更新，或者更新了但 Kernel 不知道
  
  return { compressed: true, ... };
}
```

### 3.2 指针倒置问题

```
日志：
sourceSlotStart: 51, sourceSlotEnd: 0

原因：
- currentHistoryStart = previousCompactedSlotEnd + 1 = 50 + 1 = 51
- currentHistoryEnd = ??? (可能是 0，或者没更新)

结果：
- 51 > 0，指针倒置
- readLedgerRange(51, 0) 返回空数组
- Kernel 认为 current history 是空的，但 context history 也没加载
```

---

## 4. 修复方案

### 4.1 实现状态机

```typescript
// src/runtime/context-compact-state-machine.ts

type CompactState = 'IDLE' | 'PENDING' | 'COMPACTING' | 'WRITING_DIGEST' | 'UPDATING_POINTERS' | 'NOTIFY_KERNEL' | 'FAILED';

interface CompactContext {
  sessionId: string;
  contextUsagePercent: number;
  turnId: string;
  startedAt: number;
  state: CompactState;
  error?: string;
}

class ContextCompactStateMachine {
  private stateBySession = new Map<string, CompactContext>();
  
  async triggerCompact(sessionId: string, contextUsagePercent: number, turnId: string) {
    // 1. 状态检查：不能重复触发
    const existing = this.stateBySession.get(sessionId);
    if (existing && existing.state !== 'IDLE' && existing.state !== 'FAILED') {
      return false; // 正在处理中
    }
    
    // 2. 进入 PENDING
    this.transition(sessionId, 'PENDING', { contextUsagePercent, turnId });
    
    // 3. Cooldown 检查
    if (!this.checkCooldown(sessionId)) {
      this.transition(sessionId, 'IDLE');
      return false;
    }
    
    // 4. 进入 COMPACTING
    this.transition(sessionId, 'COMPACTING');
    
    try {
      // 5. 生成 digest
      const digest = await this.generateDigest(sessionId);
      this.transition(sessionId, 'WRITING_DIGEST');
      
      // 6. 写入 digest
      const lineNumber = await this.writeDigest(sessionId, digest);
      this.transition(sessionId, 'UPDATING_POINTERS');
      
      // 7. 更新指针
      await this.updatePointers(sessionId, lineNumber, digest.tokenCount);
      this.transition(sessionId, 'NOTIFY_KERNEL');
      
      // 8. 通知 Kernel
      await this.notifyKernel(sessionId);
      this.transition(sessionId, 'IDLE');
      
      return true;
    } catch (error) {
      this.transition(sessionId, 'FAILED', { error: error.message });
      return false;
    }
  }
  
  private transition(sessionId: string, newState: CompactState, data?: Partial<CompactContext>) {
    const ctx = this.stateBySession.get(sessionId) || { sessionId, startedAt: Date.now(), state: 'IDLE' };
    const oldState = ctx.state;
    ctx.state = newState;
    if (data) Object.assign(ctx, data);
    this.stateBySession.set(sessionId, ctx);
    
    // 日志
    log.info('[CompactStateMachine] State transition', {
      sessionId,
      oldState,
      newState,
      contextUsagePercent: ctx.contextUsagePercent,
      turnId: ctx.turnId,
    });
  }
}
```

### 4.2 指针更新原子性

```typescript
// src/orchestration/session-manager.ts

async updatePointersAfterCompact(
  sessionId: string,
  newDigestLineNumber: number,
  newDigestTokens: number,
): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  
  // 原子更新所有指针
  const oldPointers = {
    contextHistoryStart: session.contextHistoryStart,
    contextHistoryEnd: session.contextHistoryEnd,
    currentHistoryStart: session.currentHistoryStart,
    currentHistoryEnd: session.currentHistoryEnd,
  };
  
  try {
    // 1. 更新 context history
    session.contextHistoryEnd = newDigestLineNumber;
    session.contextHistoryTokens += newDigestTokens;
    
    // 2. 清空 current history
    session.currentHistoryStart = session.currentHistoryEnd + 1;
    session.currentHistoryTokens = 0;
    
    // 3. 预算管理
    await this.enforceContextHistoryBudget(session);
    
    // 4. 更新总计
    session.totalTokens = session.contextHistoryTokens + session.currentHistoryTokens;
    
    // 5. 持久化（原子写入）
    await this.saveSession(session);
    
    // 6. 验证指针
    this.validatePointers(session);
    
  } catch (error) {
    // 回滚
    session.contextHistoryStart = oldPointers.contextHistoryStart;
    session.contextHistoryEnd = oldPointers.contextHistoryEnd;
    session.currentHistoryStart = oldPointers.currentHistoryStart;
    session.currentHistoryEnd = oldPointers.currentHistoryEnd;
    throw error;
  }
}

private validatePointers(session: Session): void {
  // 检查指针倒置
  if (session.currentHistoryStart > session.currentHistoryEnd && session.currentHistoryTokens > 0) {
    throw new Error(`Pointer inversion detected: start=${session.currentHistoryStart}, end=${session.currentHistoryEnd}`);
  }
  
  if (session.contextHistoryStart > session.contextHistoryEnd && session.contextHistoryTokens > 0) {
    throw new Error(`Context history pointer inversion detected`);
  }
}
```

---

## 5. 验收标准

| 测试场景 | 预期结果 |
|----------|----------|
| 触发 compact (85%) | 状态机从 IDLE → PENDING → COMPACTING → ... → IDLE |
| Cooldown 内重复触发 | 直接返回，不执行压缩 |
| Digest 写入失败 | 状态 → FAILED，指针回滚 |
| 指针更新失败 | 状态 → FAILED，digest 保留但下次重试 |
| Kernel 收到通知 | rebuildContext 被调用，上下文占用下降 |
| 指针倒置检测 | validatePointers 抛出异常，阻止保存 |

---

## 6. 实施计划

| 任务 | 文件 | 优先级 |
|------|------|--------|
| 6.1 实现状态机核心 | src/runtime/context-compact-state-machine.ts | P0 |
| 6.2 指针更新原子性 | src/orchestration/session-manager.ts | P0 |
| 6.3 指针验证逻辑 | src/orchestration/session-manager.ts | P0 |
| 6.4 Kernel 重建触发 | src/runtime/runtime-facade.ts | P0 |
| 6.5 集成到 event-forwarding | src/serverx/modules/event-forwarding.impl.ts | P1 |
| 6.6 单元测试 | tests/unit/runtime/context-compact-state-machine.test.ts | P1 |
| 6.7 E2E 测试 | tests/e2e/context-compact-e2e.test.ts | P1 |

---

## 7. 变更记录

| 日期 | 变更 | 说明 |
|------|------|------|
| 2026-04-07 | 初始设计 | 定义状态机、指针更新、验证逻辑 |
