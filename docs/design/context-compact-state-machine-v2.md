# Context Compact 状态机设计 V2

> 状态：实施中  
> 创建时间：2026-04-07  
> 问题：当前实现指针模型错误，导致压缩后 Kernel 无法正确加载

---

## 1. 当前代码问题诊断

### 1.1 指针模型不匹配

**当前实现** (`session-types.ts`):
```typescript
export interface Session {
  latestCompactIndex: number;    // 压缩块位置
  originalStartIndex: number;    // 有效窗口起始
  originalEndIndex: number;      // 有效窗口结束
  totalTokens: number;
}
```

**问题**：单链表式指针，没有区分 Context History 和 Current History。

**设计文档要求**:
```typescript
interface SessionPointers {
  contextHistory: { startLine, endLine, estimatedTokens };  // 已压缩
  currentHistory: { startLine, endLine, estimatedTokens };  // 活跃消息
}
```

### 1.2 指针更新 Bug

**`compactSessionHistory` 中的错误代码**:
```typescript
const newStartIndex = session.originalEndIndex + 1;
const newEndIndex = session.originalEndIndex;  // ❌ 错误！

// 结果：start > end，指针倒置
// readLedgerRange(51, 0) 返回空数组
```

### 1.3 缺少状态机

- 没有显式状态转换
- 并发调用可能导致重复压缩
- 没有失败回滚机制

---

## 2. 修复方案

### 2.1 指针模型修复

**新指针结构** (兼容旧字段):
```typescript
export interface Session {
  // 旧字段 (保持兼容)
  latestCompactIndex: number;
  originalStartIndex: number;
  originalEndIndex: number;
  totalTokens: number;
  
  // 新字段 (双层指针)
  pointers?: {
    contextHistory: {
      startLine: number;      // compact-memory.jsonl 起始
      endLine: number;        // compact-memory.jsonl 结束
      estimatedTokens: number;
    };
    currentHistory: {
      startLine: number;      // context-ledger.jsonl 起始
      endLine: number;        // context-ledger.jsonl 结束
      estimatedTokens: number;
    };
  };
}
```

### 2.2 指针更新逻辑修复

```typescript
// 压缩后正确更新指针
function updatePointersAfterCompact(session, compactLineNumber, digestTokens) {
  // 1. Context History 扩展
  if (!session.pointers) {
    session.pointers = {
      contextHistory: { startLine: 0, endLine: -1, estimatedTokens: 0 },
      currentHistory: { 
        startLine: session.originalStartIndex, 
        endLine: session.originalEndIndex,
        estimatedTokens: session.totalTokens 
      }
    };
  }
  
  session.pointers.contextHistory.endLine = compactLineNumber;
  session.pointers.contextHistory.estimatedTokens += digestTokens;
  
  // 2. Current History 清空（重置到当前位置）
  const lastLine = session.pointers.currentHistory.endLine;
  session.pointers.currentHistory.startLine = lastLine + 1;
  session.pointers.currentHistory.endLine = lastLine;  // 空窗口
  session.pointers.currentHistory.estimatedTokens = 0;
  
  // 3. 更新旧字段（兼容）
  session.latestCompactIndex = compactLineNumber;
  session.originalStartIndex = session.pointers.currentHistory.startLine;
  session.originalEndIndex = session.pointers.currentHistory.endLine;
  session.totalTokens = session.pointers.contextHistory.estimatedTokens;
  
  // 4. 预算管理
  enforceBudget(session);
  
  // 5. 验证
  validatePointers(session);
}

function validatePointers(session) {
  const { contextHistory, currentHistory } = session.pointers!;
  
  // 检查倒置
  if (currentHistory.startLine > currentHistory.endLine && currentHistory.estimatedTokens > 0) {
    throw new Error(`Pointer inversion: start=${currentHistory.startLine}, end=${currentHistory.endLine}`);
  }
  
  if (contextHistory.startLine > contextHistory.endLine && contextHistory.estimatedTokens > 0) {
    throw new Error(`Context history inversion`);
  }
}
```

### 2.3 状态机实现

```typescript
type CompactState = 'IDLE' | 'PENDING' | 'COMPACTING' | 'WRITING_DIGEST' | 'UPDATING_POINTERS' | 'NOTIFY_KERNEL' | 'FAILED';

interface CompactContext {
  sessionId: string;
  state: CompactState;
  startedAt: number;
  error?: string;
}

class ContextCompactStateMachine {
  private states = new Map<string, CompactContext>();
  
  async triggerCompact(sessionId: string, contextUsagePercent: number, turnId: string): Promise<boolean> {
    // 检查是否已在处理
    const existing = this.states.get(sessionId);
    if (existing && !['IDLE', 'FAILED'].includes(existing.state)) {
      log.info('[CompactStateMachine] Already processing', { sessionId, state: existing.state });
      return false;
    }
    
    this.transition(sessionId, 'PENDING', { contextUsagePercent, turnId });
    
    try {
      // Cooldown 检查
      if (!this.checkCooldown(sessionId)) {
        this.transition(sessionId, 'IDLE');
        return false;
      }
      
      this.transition(sessionId, 'COMPACTING');
      
      // 生成 digest
      const digest = await generateDigest(sessionId);
      this.transition(sessionId, 'WRITING_DIGEST');
      
      // 写入 compact-memory
      const lineNumber = await writeDigest(sessionId, digest);
      this.transition(sessionId, 'UPDATING_POINTERS');
      
      // 更新指针
      await updatePointersAfterCompact(sessionId, lineNumber, digest.tokenCount);
      this.transition(sessionId, 'NOTIFY_KERNEL');
      
      // 通知 Kernel
      await notifyKernel(sessionId);
      this.transition(sessionId, 'IDLE');
      
      return true;
    } catch (error) {
      this.transition(sessionId, 'FAILED', { error: error.message });
      throw error;
    }
  }
  
  private transition(sessionId: string, newState: CompactState, data?: Partial<CompactContext>) {
    const ctx = this.states.get(sessionId) || { sessionId, state: 'IDLE', startedAt: Date.now() };
    const oldState = ctx.state;
    ctx.state = newState;
    if (data) Object.assign(ctx, data);
    this.states.set(sessionId, ctx);
    
    log.info('[CompactStateMachine] Transition', {
      sessionId, oldState, newState,
      contextUsagePercent: ctx.contextUsagePercent,
      turnId: ctx.turnId
    });
  }
}
```

---

## 3. 实施计划

| 任务 | 文件 | 优先级 | 说明 |
|------|------|--------|------|
| 3.1 更新 Session 类型 | src/orchestration/session-types.ts | P0 | 添加 pointers 字段 |
| 3.2 修复指针更新 | src/runtime/context-history-compact.ts | P0 | 修复 newEndIndex 逻辑 |
| 3.3 实现状态机 | src/runtime/context-compact-state-machine.ts | P0 | 新建文件 |
| 3.4 集成状态机 | src/runtime/runtime-facade.ts | P0 | maybeAutoCompact 调用状态机 |
| 3.5 验证指针 | src/orchestration/session-manager.ts | P1 | 添加 validatePointers |
| 3.6 集成到 SessionManager | src/orchestration/session-manager.ts | P1 | updatePointersAfterCompact |
| 3.7 单元测试 | tests/unit/... | P1 | 状态机、指针更新测试 |
| 3.8 E2E 测试 | tests/e2e/... | P2 | 真实压缩流程测试 |

---

## 4. 验收标准

| 测试场景 | 预期结果 |
|----------|----------|
| 96% 触发压缩 | 状态机 IDLE → PENDING → ... → IDLE |
| 指针更新 | pointers.contextHistory.endLine 增加，pointers.currentHistory 重置 |
| 无指针倒置 | validatePointers 通过，无异常 |
| Kernel 重建 | 上下文占用从 96% 降至 < 50% |
| 并发触发 | 第二次调用返回 false，不重复压缩 |
| Cooldown 60s | 60s 内不重复触发 |
