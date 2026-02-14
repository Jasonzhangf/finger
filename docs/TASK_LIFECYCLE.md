# 任务生命周期与状态机

## 任务状态机

```
                                    ┌─────────────┐
                                    │             │
                                    ▼             │
┌──────┐  assign   ┌────────────┐  complete  ┌─────────┐
│ open │ ────────▶ │ in_progress│ ─────────▶ │ review  │
└──────┘           └─────┬──────┘            └────┬────┘
    ▲                    │                        │
    │                    │ block                  │ approve
    │                    ▼                        │
    │              ┌──────────┐                   │
    │              │ blocked  │                   │
    │              └────┬─────┘                   │
    │                   │ unblock                 │
    │                   ▼                         │
    │              ┌──────────┐                   │
    └──────────────│  failed  │◀──────────────────┤ reject
                   └────┬─────┘                   │
                        │                         │
                        │ retry/escalate          │
                        ▼                         │
                   ┌──────────┐                   │
                   │ escalated│                   │
                   └────┬─────┘                   │
                        │ resolve                 │
                        └─────────────────────────┼──────────┐
                                                  │          │
                                                  ▼          ▼
                                             ┌─────────────────┐
                                             │     closed      │
                                             └────────────────���┘
```

## 状态定义

| 状态 | 含义 | 可转换到 | 触发条件 |
------|------|----------|----------|
| `open` | 任务已创建，等待分配 | `in_progress` | Agent claim 或 Orchestrator assign |
| `in_progress` | 正在执行 | `blocked`, `failed`, `review` | 执行中遇到问题或完成 |
| `blocked` | 被阻塞，无法继续 | `in_progress`, `open` | 依赖未满足或外部问题 |
| `failed` | 执行失败 | `open`, `escalated` | 错误超过重试阈值 |
| `review` | 等待审查 | `closed`, `open` | Reviewer 审批 |
| `escalated` | 已升级，需人工介入 | `closed`, `open` | Orchestrator/人工处理 |
| `closed` | 任务完成或终止 | - | 最终状态 |

## 容错机制

### 1. 重试策略

```typescript
interface RetryConfig {
  maxRetries: number;           // 最大重试次数
  retryDelayMs: number;         // 初始延迟
  retryBackoff: 'fixed' | 'exponential';  // 退避策略
  retryableErrors: string[];    // 可重试的错误类型
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  retryBackoff: 'exponential',
  retryableErrors: [
    'TIMEOUT',
    'NETWORK_ERROR',
    'RATE_LIMIT',
    'TEMPORARY_FAILURE'
  ]
};
```

### 2. 错误分类与处理

| 错误类型 | 严重级别 | 处理策略 |
----------|----------|----------|
| `TIMEOUT` | warning | 重试（指数退避） |
| `NETWORK_ERROR` | warning | 重试，切换 SDK |
| `RATE_LIMIT` | warning | 等待后重试 |
| `VALIDATION_ERROR` | error | 标记 failed，通知 Reviewer |
| `DEPENDENCY_ERROR` | error | 标记 blocked，等待依赖 |
| `CRITICAL_ERROR` | critical | 立即 escalated |
| `AGENT_CRASH` | critical | 重启 Agent，升级任务 |

### 3. 超时管理

```typescript
interface TaskTimeout {
  taskId: string;
  timeoutMs: number;            // 任务超时时间
  startedAt: Date;
  lastHeartbeat: Date;
  heartbeatIntervalMs: number;  // 心跳间隔
}

// 默认超时配置
const TIMEOUT_CONFIG = {
  task: 30 * 60 * 1000,         // 30分钟
  heartbeat: 60 * 1000,         // 1分钟心跳
  agent: 5 * 60 * 1000,         // Agent 5分钟无响应视为失联
  review: 24 * 60 * 60 * 1000   // 审查24小时超时
};
```

## 闭环逻辑

### 阶段1: 任务创建与分配

```
┌─────────────────────────────────────────────────────────┐
│ 1. Orchestrator 创建任务 (bd create)                     │
│    - 设置 acceptance criteria                           │
│    - 设置 isMainPath 标记                               │
│    - 设置依赖关系                                       │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 2. 调度器检查依赖                                       │
│    if (所有依赖已完成) → 标记 ready                     │
│    else → 保持 open, 等待                              │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 3. Agent 领取或被分配任务                               │
│    - bd update --status in_progress --assignee <agent>  │
│    - AgentBlock 启动心跳                                │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
               [阶段2: 执行]
```

### 阶段2: 任务执行

```
┌─────────────────────────────────────────────────────────┐
│ 1. Agent 开始执行                                       │
│    - AIBlock 调用 SDK (-p 模式)                         │
│    - 定期发送心跳到 TaskBlock                           │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────���───┴──────────┬──────────────┐
          ▼                     ▼              ▼
     [正常完成]            [遇到阻塞]       [执行失败]
          │                     │              │
          ▼                     ▼              ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ bd update       │  │ bd update       │  │ 检查错误类型    │
│ --status review │  │ --status blocked│  │                 │
│ --note "产出物" │  │ 创建 blocker    │  │ 可重试?         │
└─────────────────┘  └─────────────────┘  └────────┬────────┘
                                                    │
                                          ┌────────┴────────┐
                                          ▼                 ▼
                                     [是: 重试]        [否: failed]
                                          │                 │
                                          ▼                 ▼
                                   重置 Agent         bd update
                                   重新执行           --status failed
                                                     创建 bug issue
```

### 阶段3: 审查与验收

```
┌─────────────────────────────────────────────────────────┐
│ 1. Reviewer 领取审查任务                                │
│    - bd update --status in_progress --assignee reviewer │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
     [审查通过]            [审查不通过]
          │                     │
          ▼                     ▼
┌─────────────────┐  ┌─────────────────────────┐
│ bd close        │  │ bd update --status open │
│ --reason "通过" │  │ 创建 bug issue          │
│ 标记交付物      │  │ 关联到原任务            │
│ 已验证          │  └──────────┬──────────────┘
└─────────────────┘             │
                                ▼
                         [返回阶段2: 修复]
```

### 阶段4: 闭环确认

```
┌─────────────────────────────────────────────────────────┐
│ 1. 任务 closed 后检查                                   │
│    - 依赖此任务的其他任务是否可以继续                    │
│    - 更新相关 blocked 任务状态                          │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 2. 检查 Epic 完成度                                     │
│    - 所有子任务 closed?                                │
│    - 是: 关闭 Epic                                     │
│    - 否: 继续处理剩余任务                              │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 3. 生成闭环报告                                         │
│    - 任务耗时                                          │
│    - 重试次数                                          │
│    - 审查结果                                          │
│    - 交付物清单                                        │
│    - 经验教训（可选）                                  │
└─────────────────────────────────────────────────────────┘
```

## 容错场景处理

### 场景1: Agent 失联

```typescript
async function handleAgentTimeout(agentId: string, taskId: string) {
  // 1. 标记 Agent 为 error
  await agentBlock.updateStatus(agentId, 'error');
  
  // 2. 检查任务状态
  const task = await taskBlock.get(taskId);
  
  if (task.retryCount < MAX_RETRIES) {
    // 3a. 可重试: 重新分配
    await bd.update(taskId, { 
      status: 'open',
      assignee: null 
    });
    await bd.comment(taskId, `Agent ${agentId} 失联，重新分配`);
    
    // 3b. 尝试其他 SDK
    const newAgent = await agentBlock.findIdleAgent(task.requiredRole);
    await agentBlock.assignTask(newAgent.id, taskId);
  } else {
    // 4. 超过重试次数: 升级
    await bd.update(taskId, { status: 'escalated' });
    await bd.create({
      type: 'escalation',
      title: `任务需要人工介入: ${taskId}`,
      parent: taskId,
      priority: 0
    });
  }
}
```

### 场景2: 审查多次不通过

```typescript
async function handleReviewRejected(taskId: string, reviewCount: number) {
  if (reviewCount >= 3) {
    // 3次审查不通过，升级处理
    await bd.update(taskId, { status: 'escalated' });
    await bd.create({
      type: 'decision',
      title: `任务多次审查不通过，需要决策: ${taskId}`,
      parent: taskId,
      acceptance: '决定: 重写/换人/降低标准/放弃'
    });
    
    // 通知 Orchestrator
    await eventBusBlock.emit('task:escalated', { taskId, reason: 'review_rejected' });
  } else {
    // 继续重试
    await bd.update(taskId, { status: 'open' });
    await bd.comment(taskId, `第${reviewCount}次审查不通过，重新执行`);
  }
}
```

### 场景3: 依赖任务失败

```typescript
async function handleDependencyFailed(taskId: string, failedDepId: string) {
  // 1. 检查是否有替代路径
  const alternatives = await findAlternativeTasks(failedDepId);
  
  if (alternatives.length > 0) {
    // 2a. 有替代: 创建新任务
    const newTask = await bd.create({
      type: 'task',
      title: `替代任务: ${failedDepId}`,
      parent: taskId,
      acceptance: '完成原依赖任务的目标'
    });
    
    // 更新依赖关系
    await bd.dep.remove(taskId, failedDepId);
    await bd.dep.add(taskId, newTask.id);
  } else {
    // 2b. 无替代: 标记失败
    await bd.update(taskId, { 
      status: 'failed',
      notes: `依赖任务 ${failedDepId} 失败，无法继续`
    });
    
    // 通知上游
    await eventBusBlock.emit('task:dependency_failed', { taskId, failedDepId });
  }
}
```

### 场景4: 主设任务失败

```typescript
async function handleMainPathFailed(taskId: string) {
  // 主设任务失败影响整个项目
  
  // 1. 阻塞所有下游任务
  const dependents = await bd.dep.getDependents(taskId);
  for (const dep of dependents) {
    await bd.update(dep.id, { status: 'blocked' });
    await bd.create({
      type: 'question',
      title: `主设任务 ${taskId} 失败，等待处理`,
      blocker: dep.id,
      priority: 0
    });
  }
  
  // 2. 紧急升级
  await bd.update(taskId, { status: 'escalated' });
  
  // 3. 通知 Orchestrator
  await eventBusBlock.emit('mainpath:failed', { 
    taskId,
    affectedTasks: dependents.map(d => d.id)
  });
}
```

## 状态持久化与恢复

### 检查点机制

```typescript
interface TaskCheckpoint {
  taskId: string;
  status: TaskStatus;
  agentId?: string;
  progress: number;          // 0-100
  artifacts: Artifact[];     // 已产生的交付物
  lastState: string;         // 序列化的执行状态
  timestamp: Date;
}

// 定期保存检查点
async function saveCheckpoint(taskId: string) {
  const task = await taskBlock.get(taskId);
  const agent = await agentBlock.getByTask(taskId);
  
  await storageBlock.save(`checkpoint:${taskId}`, {
    taskId,
    status: task.status,
    agentId: agent?.id,
    progress: task.progress,
    artifacts: task.artifacts,
    lastState: await agent?.getState() || null,
    timestamp: new Date()
  });
}

// 恢复执行
async function restoreFromCheckpoint(taskId: string) {
  const checkpoint = await storageBlock.load(`checkpoint:${taskId}`);
  
  if (checkpoint && checkpoint.progress < 100) {
    // 恢复 Agent 状态
    const agent = await agentBlock.spawn({
      role: checkpoint.agentRole,
      restoreState: checkpoint.lastState
    });
    
    // 继续执行
    await agentBlock.assignTask(agent.id, taskId);
    await bd.comment(taskId, `从检查点恢复，进度: ${checkpoint.progress}%`);
  }
}
```

## 监控与告警

### 关键指标

```typescript
interface TaskMetrics {
  // 时间指标
  avgCompletionTime: number;
  avgReviewTime: number;
  blockedTime: number;
  
  // 成功率
  successRate: number;
  retryRate: number;
  escalationRate: number;
  
  // Agent 指标
  agentUtilization: number;
  agentErrorRate: number;
  
  // 依赖指标
  dependencyWaitTime: number;
  criticalPathLength: number;
}
```

### 告警规则

| 条件 | 级别 | 动作 |
------|------|------|
| 任务 blocked 超过 1 小时 | warning | 通知 Orchestrator |
| 任务执行超时 | error | 尝试重试 |
| 主设任务失败 | critical | 立即升级 |
| Agent 错误率 > 20% | error | 切换 SDK 或暂停 |
| Epic 预计超期 | warning | 通知调整计划 |

## 闭环保证

### 最终一致性检查

```typescript
async function ensureConsistency() {
  // 1. 检查僵尸任务（长时间无更新）
  const zombies = await bd.list({
    status: 'in_progress',
    updatedBefore: Date.now() - 3600000  // 1小时前
  });
  
  for (const task of zombies) {
    await handleAgentTimeout(task.assignee, task.id);
  }
  
  // 2. 检查孤儿任务（无 assignee 但 in_progress）
  const orphans = await bd.list({
    status: 'in_progress',
    noAssignee: true
  });
  
  for (const task of orphans) {
    await bd.update(task.id, { status: 'open' });
  }
  
  // 3. 检查依赖循环
  const cycles = await bd.dep.detectCycles();
  for (const cycle of cycles) {
    await bd.create({
      type: 'bug',
      title: '检测到依赖循环',
      priority: 0,
      notes: `循环: ${cycle.join(' → ')}`
    });
  }
}

// 每 5 分钟执行一次
setInterval(ensureConsistency, 300000);
```

## 完整状态转换表

| 当前状态 | 事件 | 目标状态 | 副作用 |
----------|------|----------|--------|
| open | assign | in_progress | 记录 assignee，启动心跳 |
| open | cancel | closed | 记录取消原因 |
| in_progress | complete | review | 记录产出物 |
| in_progress | block | blocked | 创建 blocker issue |
| in_progress | fail | failed | 记录错误，检查重试 |
| in_progress | timeout | failed | 触发重试或升级 |
| blocked | unblock | in_progress | 移除 blocker |
| blocked | abort | closed | 记录中止原因 |
| failed | retry | open | 重置 assignee |
| failed | escalate | escalated | 通知 Orchestrator |
| escalated | resolve | closed | 记录解决方案 |
| escalated | retry | open | 重新分配 |
| review | approve | closed | 标记交付物验证通过 |
| review | reject | open | 创建 bug，重新执行 |
| review | timeout | open | 重新分配 reviewer |
| closed | reopen | open | 创建新 issue 追踪 |

## 关键约定

1. **状态转换有日志**: 每次状态变化必须记录到 bd comment
2. **超时必处理**: 任何状态超时都有明确的处理路径
3. **失败可追溯**: failed 状态必须有根因分析
4. **闭环有确认**: closed 状态必须有验收确认
5. **升级有决策**: escalated 状态必须有明确的决策记录
