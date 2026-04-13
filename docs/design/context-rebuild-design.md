# Context Rebuild 设计文档

## 1. 概述

Context Rebuild 是基于 MemPalace 语义搜索的上下文重建机制，用于在用户请求时从历史记忆中检索相关内容，重建当前对话所需的上下文。

### 核心目标

1. **减少上下文膨胀** — 不需要加载全部历史，只检索相关片段
2. **支持话题切换** — 用户切换话题时自动重建新上下文
3. **优化延迟** — 语义搜索 107ms，无需 LLM 判断即可检索

---

## 2. 触发条件

### 2.1 触发决策矩阵

| 条件 | 优先级 | 触发时机 | 置信度要求 | 说明 |
|---|---|---|---|---|
| **新 session** | P0 | `session.history.length === 0` | 1.0（立即） | 无历史，必须重建 |
| **心跳 session** | P0 | `sessionId.startsWith('hb-session')` | 1.0（立即） | 系统会话，每次重建 |
| **循环任务 (cron)** | P0 | `sourceType === 'cron'` | 1.0（立即） | 调度任务，每次重建 |
| **话题切换累积** | P1 | 多轮置信度累积 | ≥0.8 连续 3 轮 | 保守触发 |
| **上下文溢出** | P2 | `tokens > max * 0.8` | 0.9 | 压缩 + 重建 |
| **显式关键词** | P3 | `prompt.includes('之前|上次|回顾')` | 0.7 | 用户引用历史 |

### 2.2 默认策略

**保守原则：默认不触发**，除非满足以下任一条件：
- 新 session
- 心跳 session
- 循环任务
- 多轮累积触发

---

## 3. 失败处理分支

### 3.1 搜索失败

| 失败类型 | 处理策略 | 回退方案 |
|---|---|---|
| **mempalace CLI 不可用** | 返回空结果 + 记录 warn 日志 | 使用 session 原始历史 |
| **mempalace 返回 0 结果** | 正常返回，不触发重建 | 保持现有上下文 |
| **搜索超时 (>500ms)** | 返回空结果 + 记录 warn 日志 | 使用 session 原始历史 |
| **embedding 模型加载失败** | 尝试 FTS 模式 | 如果 FTS 也失败，返回空 |
| **索引损坏** | 返回错误 + 触发索引重建建议 | 使用 session 原始历史 |

### 3.2 Ledger 读取失败

| 失败类型 | 处理策略 | 回退方案 |
|---|---|---|
| **ledger 文件不存在** | 返回空结果 + 记录 warn 日志 | 使用 mempalace preview content |
| **ledger JSONL 解析错误** | 跳过错误行 + 记录 warn 日志 | 继续处理其他行 |
| **ledger 行号不匹配** | 使用 mempalace preview content | 不依赖 ledger fetch |

### 3.3 Token 计算失败

| 失败类型 | 处理策略 | 回退方案 |
|---|---|---|
| **token 估算异常** | 使用 chunk 数量限制 | `maxChunks = 20` |
| **超出 token budget** | 按 relevance 截断 | 保留 top-K chunks |

---

## 4. 心跳 Session 和循环任务处理

### 4.1 心跳 Session 标识

```typescript
function isHeartbeatSession(sessionId: string): boolean {
  return sessionId.startsWith('hb-session') 
    || sessionId.startsWith('system-')
    || sessionId.includes('heartbeat');
}

function isCronTask(sourceType: string): boolean {
  return sourceType === 'cron' 
    || sourceType === 'clock'
    || sourceType.includes('schedule');
}
```

### 4.2 心跳 Session 重建策略

**每次请求都重建**，原因：
- 心跳 session 是系统会话，无用户对话历史
- 需要从全局记忆中检索系统状态、配置、错误日志
- 不需要累积判断，直接触发

```typescript
// 心跳 session 触发逻辑
if (isHeartbeatSession(sessionId) || isCronTask(sourceType)) {
  // 立即触发 context rebuild
  const result = await runContextRebuildWithMemPalace({
    sessionId,
    agentId,
    prompt: systemPrompt, // 使用系统 prompt
    mode: 'embed',
    topK: 15,
    maxTokens: 4000, // 心跳 session 使用更小的 budget
  });
  
  if (!result.ok || result.rankedBlocks.length === 0) {
    // 失败回退：使用全局 MEMORY.md
    return loadGlobalMemory();
  }
  
  return result.rankedBlocks;
}
```

### 4.3 循环任务重建策略

**每次调度都重建**，原因：
- 循环任务（dailySystemReview、健康检查）需要最新的系统状态
- 任务之间可能间隔较长，上下文需要更新
- 不依赖用户对话，需要从全局记忆检索

---

## 5. 话题切换累积触发

### 5.1 ControlBlock 设计

```typescript
interface TopicShiftControl {
  /** 上次用户话题（LLM 从历史中提取） */
  last_topic: string | null;
  /** 当前用户话题 */
  current_topic: string;
  /** 是否是新话题 */
  is_new_topic: boolean;
  /** 置信度（0-1） */
  confidence: number;
  /** 话题切换原因 */
  reason?: 'user_explicit' | 'content_mismatch' | 'time_gap' | 'keyword_shift';
}
```

### 5.2 LLM Prompt 指令

```
## 话题判断规则

在每次回复的 ControlBlock metadata 中，你需要判断话题切换：

1. 分析用户当前问题的话题（简短描述，如 "询问 heartbeat 实现"）
2. 从最近 3-5 轮对话中提取上次话题
3. 判断是否是新话题（is_new_topic: boolean）
4. 给出置信度（confidence: 0-1）

判断标准：
- 用户显式切换话题（"换个话题"、"话说"） → confidence = 0.95
- 内容领域完全不同（代码 vs 配置 vs 运维） → confidence = 0.85
- 关键词无重叠 → confidence = 0.70
- 部分重叠但关注点不同 → confidence = 0.50

输出格式（在 response.metadata.control 中）：
{
  "control": {
    "last_topic": "讨论 heartbeat broker 实现",
    "current_topic": "询问 ledger 压缩逻辑",
    "is_new_topic": true,
    "confidence": 0.85,
    "reason": "content_mismatch"
  }
}
```

### 5.3 多轮累积触发器

```typescript
interface TopicShiftTracker {
  /** 累积轮数 */
  accumulationCount: number;
  /** 最近 N 轮的置信度 */
  confidenceHistory: number[];
  /** 触发阈值 */
  threshold: number; // 默认 0.8
  /** 触发所需的连续轮数 */
  requiredRounds: number; // 默认 3
  /** 最大保留历史长度 */
  maxHistoryLength: number; // 默认 10
}

class TopicShiftDetector {
  private tracker: TopicShiftTracker = {
    accumulationCount: 0,
    confidenceHistory: [],
    threshold: 0.8,
    requiredRounds: 3,
    maxHistoryLength: 10,
  };

  /**
   * 检测是否应该触发 context rebuild
   */
  shouldTrigger(control: TopicShiftControl | null): boolean {
    // 无 control 信息 → 不触发
    if (!control) {
      this.reset();
      return false;
    }

    // 不是新话题 → 清空累积
    if (!control.is_new_topic) {
      this.reset();
      return false;
    }

    // 是新话题 → 累积置信度
    this.tracker.confidenceHistory.push(control.confidence);
    this.tracker.accumulationCount++;

    // 限制历史长度
    if (this.tracker.confidenceHistory.length > this.tracker.maxHistoryLength) {
      this.tracker.confidenceHistory.shift();
    }

    // 判断：连续 requiredRounds 轮置信度都 >= threshold
    if (this.tracker.accumulationCount >= this.tracker.requiredRounds) {
      const recent = this.tracker.confidenceHistory.slice(-this.tracker.requiredRounds);
      if (recent.every(c => c >= this.tracker.threshold)) {
        // 触发 context rebuild
        this.reset();
        return true;
      }
    }

    return false;
  }

  /**
   * 重置累积状态
   */
  private reset(): void {
    this.tracker.accumulationCount = 0;
    this.tracker.confidenceHistory = [];
  }

  /**
   * 获取当前状态（用于调试/日志）
   */
  getStatus(): TopicShiftTracker {
    return { ...this.tracker };
  }
}
```

### 5.4 状态持久化

```typescript
// TopicShiftTracker 存放在 session context 中
interface SessionContext {
  // ... 现有字段
  topicShiftTracker?: TopicShiftTracker;
}

// 每次对话结束时持久化到 ledger
async function persistTopicShiftTracker(sessionId: string, tracker: TopicShiftTracker): void {
  await appendLedgerEvent(sessionId, {
    type: 'topic_shift_tracker_update',
    payload: {
      accumulationCount: tracker.accumulationCount,
      confidenceHistory: tracker.confidenceHistory,
      timestamp: Date.now(),
    },
  });
}
```

---

## 6. 完整触发决策流程

```typescript
async function decideContextRebuild(
  session: Session,
  prompt: string,
  sourceType: string,
  currentTokens: number,
  maxTokens: number,
): Promise<{ shouldRebuild: boolean; reason: string }> {

  // P0: 新 session
  if (session.messages.length === 0) {
    return { shouldRebuild: true, reason: 'new_session' };
  }

  // P0: 心跳 session
  if (isHeartbeatSession(session.id)) {
    return { shouldRebuild: true, reason: 'heartbeat_session' };
  }

  // P0: 循环任务
  if (isCronTask(sourceType)) {
    return { shouldRebuild: true, reason: 'cron_task' };
  }

  // P2: 上下文溢出
  if (currentTokens > maxTokens * 0.8) {
    return { shouldRebuild: true, reason: 'context_overflow' };
  }

  // P3: 显式关键词
  const historyKeywords = ['之前', '上次', '还记得', '回顾', '刚才', '前面'];
  if (historyKeywords.some(kw => prompt.includes(kw))) {
    return { shouldRebuild: true, reason: 'explicit_keyword' };
  }

  // P1: 话题切换累积
  const control = extractControlFromLastResponse(session);
  if (control && control.is_new_topic) {
    const tracker = session.context.topicShiftTracker || createDefaultTracker();
    const detector = new TopicShiftDetector(tracker);
    if (detector.shouldTrigger(control)) {
      return { shouldRebuild: true, reason: 'topic_shift_accumulation' };
    }
  }

  // 默认：不触发
  return { shouldRebuild: false, reason: 'none' };
}
```

---

## 7. 执行流程

```typescript
async function executeContextRebuild(
  sessionId: string,
  agentId: string,
  prompt: string,
  options: ContextRebuildOptions,
): Promise<ContextRebuildResult> {

  const startTime = Date.now();

  try {
    // 1. 直接 tokenize 搜索（无需 LLM）
    const searchResult = await mempalaceSearch(prompt, {
      wing: 'finger-ledger',
      mode: options.mode || 'embed',
      topK: options.topK || 12,
    });

    // 2. 搜索失败处理
    if (!searchResult.ok || searchResult.results.length === 0) {
      log.warn('Context rebuild search returned no results', {
        sessionId,
        prompt: prompt.substring(0, 50),
        latency: searchResult.latencyMs,
      });
      return {
        ok: false,
        rankedBlocks: [],
        totalChunks: 0,
        latencyMs: Date.now() - startTime,
        error: 'search_no_results',
      };
    }

    // 3. 超时处理
    if (searchResult.latencyMs > 500) {
      log.warn('Context rebuild search timeout', {
        sessionId,
        latency: searchResult.latencyMs,
      });
      // 继续处理，但记录警告
    }

    // 4. 直接使用 mempalace preview content（不依赖 ledger fetch）
    const blocks = searchResult.results.map((r, i) => ({
      id: r.id,
      startTime: Date.now(),
      endTime: Date.now(),
      startTimeIso: new Date().toISOString(),
      endTimeIso: new Date().toISOString(),
      messages: [{
        id: r.id,
        role: 'assistant',
        content: r.content,
        timestamp: Date.now(),
        timestampIso: new Date().toISOString(),
        tokenCount: estimateTokenCount(r.content),
      }],
      tokenCount: estimateTokenCount(r.content),
      relevanceScore: 1 - (i / searchResult.results.length), // 简单按排序给分数
      tags: [r.source],
      topic: r.room,
    }));

    // 5. Token budget 控制
    const maxTokens = options.maxTokens || 8000;
    let totalTokens = 0;
    const selectedBlocks: TaskBlock[] = [];

    for (const block of blocks) {
      if (totalTokens + block.tokenCount <= maxTokens) {
        selectedBlocks.push(block);
        totalTokens += block.tokenCount;
      } else {
        break;
      }
    }

    return {
      ok: true,
      rankedBlocks: selectedBlocks,
      totalChunks: searchResult.results.length,
      latencyMs: Date.now() - startTime,
      tokensUsed: totalTokens,
    };

  } catch (err) {
    log.error('Context rebuild execution failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      ok: false,
      rankedBlocks: [],
      totalChunks: 0,
      latencyMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

---

## 8. 集成点

### 8.1 RuntimeFacade

```typescript
// src/runtime/runtime-facade.ts

async function buildContext(session: Session, prompt: string, sourceType: string): Promise<TaskBlock[]> {
  // 1. 决策是否需要 rebuild
  const decision = await decideContextRebuild(session, prompt, sourceType, currentTokens, maxTokens);

  if (decision.shouldRebuild) {
    log.info('Context rebuild triggered', {
      sessionId: session.id,
      reason: decision.reason,
    });

    // 2. 执行 rebuild
    const result = await executeContextRebuild(session.id, session.agentId, prompt, {
      mode: 'embed',
      topK: 12,
      maxTokens: 8000,
    });

    if (result.ok) {
      return result.rankedBlocks;
    }
  }

  // 3. 默认：使用现有历史
  return session.historyBlocks || [];
}
```

### 8.2 HeartbeatScheduler

```typescript
// src/server/modules/heartbeat-scheduler.ts

async function triggerHeartbeatTask(task: HeartbeatTask): Promise<void> {
  // 心跳任务每次都重建上下文
  const contextBlocks = await executeContextRebuild(
    task.sessionId,
    task.agentId,
    task.systemPrompt, // 使用任务定义的系统 prompt
    {
      mode: 'embed',
      topK: 15,
      maxTokens: 4000, // 心跳任务使用较小 budget
    },
  );

  // 执行任务...
}
```

---

## 9. 性能指标

| 指标 | 目标值 | 实测值 |
|---|---|---|
| **搜索延迟** | <200ms | 107ms (embed) |
| **重建延迟** | <300ms | 269ms |
| **token 命中率** | >70% | 需实测 |
| **失败回退延迟** | <50ms | 使用现有历史 |

---

## 10. 后续优化

1. **索引增量更新** — heartbeat 触发 ledger-to-mempalace 自动索引
2. **FTS + Embed 混合** — 对关键术语用 FTS，对语义用 Embed
3. **ControlBlock 集成** — LLM prompt 修改，返回话题判断 metadata
4. **状态持久化** — TopicShiftTracker 存放到 ledger

---

## 11. 测试验收

- [ ] 新 session 触发 rebuild
- [ ] 心跳 session 每次触发
- [ ] 循环任务每次触发
- [ ] 多轮累积触发（连续 3 轮 >= 0.8）
- [ ] 搜索失败回退（mempalace 不可用）
- [ ] 搜索超时回退 (>500ms)
- [ ] ledger 读取失败回退
- [ ] token budget 控制

