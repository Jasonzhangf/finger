# Team Status 设计 Self-Review

## 发现的问题

### P0（必须修复）

**1. 启动时机问题：首次启动延迟**

- **问题**：移除 `startMonitoredProjects()` 后，Project Agent 的启动要等待 PeriodicCheckRunner 的第一个 interval（5 分钟）
- **风险**：用户启动 daemon 后，Project Agent 不会立即工作
- **修复**：在 `PeriodicCheckRunner.start()` 后立即触发一次 `runOnce()`，或在 `start()` 中调用 `runOnceOnceImmediately()`

**2. team-status.json 写入冲突**

- **问题**：多个 agent 同时调用 `update_plan` 可能导致文件写入冲突
- **风险**：数据丢失或文件损坏
- **修复**：使用 `writeFileAtomicSync`（已有）或添加文件锁机制

**3. 缺少 workerId 字段**

- **问题**：TeamAgentStatus 结构缺少 `workerId`，无法区分同一 agent 的不同执行实例
- **风险**：一个 agent 可能被多个 worker 执行，状态混乱
- **修复**：添加 `workerId?: string` 字段，从 session context 的 `memoryOwnerWorkerId` 获取

### P1（建议修复）

**4. Scope 可见性不够精确**

- **问题**：只按 `projectPath` 过滤，但同一 project 可以有多个 session
- **风险**：Project Agent 可能看到不相关的 session 状态
- **修复**：添加 `dispatchScopeKey` 或 `sessionId` 作为过滤维度

**5. team.status 工具权限控制不清晰**

- **问题**：`update` action 只能更新自己，但缺少权限校验
- **风险**：恶意 agent 可能伪造 agentId 更新其他 agent 的状态
- **修复**：`update` action 必须校验 `input.agentId === context.agentId`

**6. 缺少清理机制**

- **问题**：agent unregister 时，team-status.json 中对应记录不会被清理
- **风险**：过期数据堆积，影响查询性能
- **修复**：在 `system-registry-tool.ts` 的 unregister 逻辑中，清理对应的 team status 记录

### P2（可选改进）

**7. Context Slot 设计不完整**

- **问题**：只提到新增 slot，但没有内容格式和更新频率
- **建议**：
  - 格式：`[agentId] status=idle plan=3/5 task=xxx`
  - 更新频率：每次 PeriodicCheckRunner.runOnce() 更新
  - maxChars：800

**8. 缺少实时订阅机制**

- **问题**：team.status 只能查询当前状态，无法订阅状态变化
- **建议**：后续可添加 `watch` action，通过 eventBus 推送状态变化

**9. 缺少错误恢复策略**

- **问题**：team-status.json 捠坏时没有恢复策略
- **建议**：loadTeamStatusStore 遇到损坏文件时，返回空 store 并记录日志

---

## 设计决策确认

### Q1：team.status 工具的权限？

**决策**：
- Project Agent 可以调用 `update` action，但只能更新自己的 `planSummary`
- `runtimeStatus` 只由 `PeriodicCheckRunner` 更新（从 runtime_view 获取）
- 权限校验：`update` action 必须校验 `input.agentId === context.agentId`

### Q2：System Agent 的 plan 显示？

**决策**：
- System Agent 的 `planSummary` 和 `taskLifecycle` 对 Project Agent 隐藏
- Project Agent 只能看到 System Agent 的 `runtimeStatus`（idle/busy）
- 这样可以保护系统任务的隐私

### Q3：启动时机？

**决策**：
- `PeriodicCheckRunner.start()` 后立即调用一次 `runOnce()`
- 这样确保 daemon 启动后 Project Agent 立即开始工作
- 后续按 5 分钟 interval 执行

---

## 改进后的数据结构

```typescript
interface TeamAgentStatus {
  agentId: string;
  workerId?: string;  // 新增：区分同一 agent 的不同执行实例
  sessionId?: string; // 新增：当前活跃的 session
  projectId: string;
  projectPath: string;
  role: 'system' | 'project';
  dispatchScopeKey?: string; // 新增：用于更精确的 scope 过滤
  
  // Runtime 状态（来自 runtime_view，只由 PeriodicCheckRunner 更新）
  runtimeStatus: 'idle' | 'running' | 'queued' | 'waiting_input' | 'paused' | 'failed' | 'stopped';
  lastDispatchId?: string;
  lastTaskId?: string;
  lastTaskName?: string;
  
  // Plan 进度（来自 update_plan，agent 自己更新）
  planSummary?: {
    total: number;
    completed: number;
    inProgress: number;
    blocked: number;
    currentStep?: string;
    updatedAt: string;
  };
  
  // Task 生命周期（来自 projectTaskState，只由 PeriodicCheckRunner 更新）
  taskLifecycle?: {
    active: boolean;
    status: string;
    taskId?: string;
    updatedAt: string;
  };
  
  updatedAt: string;
}
```

---

## 改进后的启动流程

```typescript
// src/serverx/modules/system-agent-manager.impl.ts

async start(): Promise<void> {
  await this.startSystemAgent();
  // 移除 startMonitoredProjects()
  this.periodicCheckRunner.start();
  
  // 立即触发一次 runOnce，确保 Project Agent 立即启动
  await this.periodicCheckRunner.runOnceImmediately();
}

// src/agents/finger-system-agent/periodic-check.ts

async start(): void {
  this.timer = setInterval(() => this.runOnce(), this.intervalMs);
}

async runOnceImmediately(): Promise<void> {
  await this.runOnce();
}
```

---

## 改进后的工具权限校验

```typescript
// src/tools/internal/team-status-tool.ts

async execute(input: TeamStatusToolInput, context: ToolExecutionContext): Promise<TeamStatusToolOutput> {
  if (input.action === 'update') {
    // 权限校验：只能更新自己
    if (input.agentId !== context.agentId) {
      return {
        ok: false,
        action: 'update',
        error: 'permission_denied: can only update own status',
      };
    }
    
    // 只允许更新 planSummary，不允许更新 runtimeStatus
    const store = loadTeamStatusStore();
    const now = new Date().toISOString();
    
    store.agents[context.agentId] = {
      ...store.agents[context.agentId],
      agentId: context.agentId,
      projectPath: context.projectPath,
      planSummary: {
        ...input.planSummary,
        updatedAt: now,
      },
      updatedAt: now,
    };
    
    persistTeamStatusStore(store);
    
    return {
      ok: true,
      action: 'update',
      self: store.agents[context.agentId],
    };
  }
  
  // status action...
}
```

---

## 改进后的清理机制

```typescript
// src/tools/internal/system-registry-tool.ts

async unregister(projectId: string): Promise<void> {
  const agent = await this.getAgentByProjectId(projectId);
  if (!agent) return;
  
  // 清理 registry
  await this.removeAgentFromRegistry(projectId);
  
  // 清理 team status
  const store = loadTeamStatusStore();
  delete store.agents[agent.agentId];
  persistTeamStatusStore(store);
}
```

---

## 下一步行动

1. 更新设计文档，添加上述改进点
2. 创建 bd epic 和 task 来追踪实现
3. 按 P0/P1 优先级实现

