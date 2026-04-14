# Team Status & System Agent Control 设计（v2 - Review 后）

## 背景

当前问题：
1. System Agent 无法感知 Project Team 的实时状态（plan progress、busy/idle）
2. Project Agent 之间无法看到同 project 内的其他 agent 状态
3. 启动流程：daemon 直接启动 monitored Project Agent，System Agent 无法控制启动时机
4. update_plan 的状态只存在于各自的 session context 中，无法跨 session 共享

## 设计目标

1. **Team Status 共享**：每个 agent 的 `update_plan` 自动同步到全局 team status
2. **Scope 可见性**：
   - System Agent：看到所有 project agents 的状态
   - Project Agent：看到同 project 内的其他 agents + System Agent 的闲忙状态
3. **启动流程调整**：System Agent 主动控制 Project Agent 的启动和监控
4. **状态持久化**：team status 存储在 `~/.finger/system/team-status.json`

---

## 核心设计

### 1. Team Status 数据结构

```typescript
interface TeamAgentStatus {
  agentId: string;
  workerId?: string;  // 区分同一 agent 的不同执行实例
  sessionId?: string; // 当前活跃的 session
  projectId: string;
  projectPath: string;
  role: 'system' | 'project';
  dispatchScopeKey?: string; // 用于更精确的 scope 过滤
  
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

interface TeamStatusStore {
  version: number;
  lastUpdate: string;
  agents: Record<string, TeamAgentStatus>;
}
```

存储位置：`~/.finger/system/team-status.json`

### 2. Scope 可见性规则

```typescript
function filterTeamStatusByScope(
  store: TeamStatusStore,
  viewerAgentId: string,
  viewerProjectPath: string,
  viewerRole: 'system' | 'project',
  viewerScopeKey?: string
): TeamAgentStatus[] {
  const allAgents = Object.values(store.agents);
  
  if (viewerRole === 'system') {
    // System Agent 看到全部
    return allAgents;
  }
  
  // Project Agent：
  // 1. 看到同 project + 同 scope 内的其他 agents
  // 2. 看到 System Agent 的闲忙状态（只看 runtimeStatus）
  return allAgents.filter(agent => {
    if (agent.role === 'system') {
      return true; // System Agent 总可见
    }
    // 同 project，且 scope 匹配（如果有）
    if (agent.projectPath !== viewerProjectPath) return false;
    if (viewerScopeKey && agent.dispatchScopeKey && agent.dispatchScopeKey !== viewerScopeKey) {
      return false;
    }
    return true;
  }).map(agent => {
    if (agent.role === 'system') {
      // System Agent 只返回 runtimeStatus，不暴露 task/plan 详情
      return {
        agentId: agent.agentId,
        runtimeStatus: agent.runtimeStatus,
        updatedAt: agent.updatedAt,
      };
    }
    return agent;
  });
}
```

### 3. team.status 工具设计

```typescript
interface TeamStatusToolInput {
  action: 'status' | 'update';
  agentId?: string;  // update 时指定自己的 agentId（必须等于 context.agentId）
  planSummary?: {
    total: number;
    completed: number;
    inProgress: number;
    blocked: number;
    currentStep?: string;
  };
}

interface TeamStatusToolOutput {
  ok: boolean;
  action: 'status' | 'update';
  scope: 'system' | 'project';
  viewerAgentId: string;
  agents?: TeamAgentStatus[];
  self?: TeamAgentStatus;
  error?: string;
}
```

**权限规则**：
- `update` action 必须校验 `input.agentId === context.agentId`
- 只允许更新 `planSummary`，不允许更新 `runtimeStatus`
- `runtimeStatus` 只由 `PeriodicCheckRunner` 从 `runtime_view` 更新

### 4. update_plan 同步机制

在 `codex-update-plan-tool.ts` 中，每次 `update_plan` 成功后：
1. 计算 planSummary（total/completed/inProgress/blocked）
2. 调用 `syncTeamStatusFromPlan(agentId, projectPath, workerId, planSummary)`
3. 使用 `writeFileAtomicSync` 写入（避免并发冲突）

```typescript
function syncTeamStatusFromPlan(
  agentId: string,
  projectPath: string,
  workerId: string | undefined,
  planSummary: PlanSummary
): void {
  const store = loadTeamStatusStore();
  const now = new Date().toISOString();
  
  store.agents[agentId] = {
    ...store.agents[agentId],
    agentId,
    projectPath,
    workerId,
    planSummary: {
      ...planSummary,
      updatedAt: now,
    },
    updatedAt: now,
  };
  
  persistTeamStatusStore(store); // 使用 writeFileAtomicSync
}
```

### 5. PeriodicCheckRunner 同步机制

在 `periodic-check.ts` 的 `runOnce()` 中：
1. 获取 runtime_view（所有 agents 的 runtimeStatus）
2. 遍历每个 agent，更新 team-status.json 的 runtimeStatus 字段
3. 启动未运行的 monitored agents
4. 使用 `writeFileAtomicSync` 写入

```typescript
async runOnce(): Promise<void> {
  const runtimeView = await this.deps.agentRuntimeBlock.execute('runtime_view', {});
  const registryAgents = await listAgents();
  const monitoredAgents = registryAgents.filter(a => a.monitored);
  
  const runningAgentIds = new Set(runtimeView.agents.map(a => a.id));
  
  // 1. 启动未运行的 monitored agents
  for (const agent of monitoredAgents) {
    if (!runningAgentIds.has(agent.agentId)) {
      await this.startProjectAgent(agent);
    }
  }
  
  // 2. 更新 team status
  const store = loadTeamStatusStore();
  for (const agent of runtimeView.agents) {
    const agentId = agent.id;
    store.agents[agentId] = {
      ...store.agents[agentId],
      agentId,
      runtimeStatus: agent.status,
      lastDispatchId: agent.lastEvent?.dispatchId,
      lastTaskId: agent.lastEvent?.taskId,
      lastTaskName: agent.lastEvent?.taskName,
      updatedAt: new Date().toISOString(),
    };
  }
  persistTeamStatusStore(store);
  
  // 3. 原有的 heartbeat 发送逻辑...
}
```

### 6. 清理机制

在 `system-registry-tool.ts` 的 unregister 逻辑中：
```typescript
async unregister(projectId: string): Promise<void> {
  const agent = await this.getAgentByProjectId(projectId);
  if (!agent) return;
  
  await this.removeAgentFromRegistry(projectId);
  
  // 清理 team status
  const store = loadTeamStatusStore();
  delete store.agents[agent.agentId];
  persistTeamStatusStore(store);
}
```

### 7. 错误恢复策略

```typescript
function loadTeamStatusStore(): TeamStatusStore {
  const file = FINGER_PATHS.systemTeamStatusFile;
  try {
    if (!existsSync(file)) return { version: 1, lastUpdate: new Date().toISOString(), agents: {} };
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (error) {
    log.warn('team-status.json corrupted, returning empty store');
    return { version: 1, lastUpdate: new Date().toISOString(), agents: {} };
  }
}
```

---

## 启动流程调整

### 原流程
```
daemon-guard → daemon
  → SystemAgentManager.start()
    → startSystemAgent()
    → startMonitoredProjects()  ← 直接启动所有 monitored Project Agent
    → PeriodicCheckRunner.start()
```

### 新流程
```
daemon-guard → daemon
  → SystemAgentManager.start()
    → startSystemAgent()
    → PeriodicCheckRunner.start()
    → await periodicCheckRunner.runOnceImmediately()  ← 立即启动 Project Agent
```

### 立即启动逻辑

```typescript
// SystemAgentManager
async start(): Promise<void> {
  await this.startSystemAgent();
  this.periodicCheckRunner.start();
  await this.periodicCheckRunner.runOnceImmediately();
}

// PeriodicCheckRunner
start(): void {
  this.timer = setInterval(() => this.runOnce(), this.intervalMs);
}

runOnceImmediately(): Promise<void> {
  return this.runOnce();
}
```

---

## 文件修改清单

### 新增文件
| 文件路径 | 说明 |
|---------|------|
| `src/common/team-status-state.ts` | TeamStatus 数据结构 + load/persist 函数 |
| `src/tools/internal/team-status-tool.ts` | team.status 工具实现 |
| `tests/unit/tools/team-status.test.ts` | 单元测试 |
| `tests/integration/team-status.test.ts` | 集成测试 |

### 修改文件
| 文件路径 | 修改内容 |
|---------|---------|
| `src/tools/internal/codex-update-plan-tool.ts` | 每次 update 后调用 syncTeamStatusFromPlan |
| `src/agents/finger-system-agent/periodic-check.ts` | 启动 monitored agents + 更新 team status |
| `src/serverx/modules/system-agent-manager.impl.ts` | 移除 startMonitoredProjects + 立即 runOnce |
| `src/tools/internal/system-registry-tool.ts` | unregister 时清理 team status |
| `src/agents/base/kernel-agent-base.ts` | 新增 task.team_status context slot |
| `src/agents/chat-codex/agent-role-config.ts` | 注册 team.status 工具 |

---

## Context Slot 设计

### task.team_status slot

**格式**：
```
Team status snapshot (scope: project):
- [finger-project-agent] status=idle plan=3/5 task=fix-ledger
- [finger-project-agent-2] status=running plan=1/2
- [finger-system-agent] status=busy

Rule: check team.status before dispatching new task to avoid conflict.
```

**更新频率**：每次 PeriodicCheckRunner.runOnce()
**maxChars**：800

---

## 测试计划

### 单元测试
1. `team-status-state.ts`：load/persist/scope filtering/错误恢复
2. `team-status-tool.ts`：status/update/权限校验
3. `periodic-check.ts`：启动未运行 agent/更新 team status

### 集成测试
1. daemon 启动 → System Agent → PeriodicCheck → Project Agent 启动
2. Project Agent update_plan → team.status 更新
3. System Agent team.status → 看到 Project Agent 进度
4. agent unregister → team status 清理

---

## 设计决策确认

| 问题 | 决策 |
|------|------|
| team.status 工具权限 | `update` 只能更新自己的 `planSummary`，必须校验 `input.agentId === context.agentId` |
| System Agent plan 显示 | 对 Project Agent 隐藏 `planSummary` 和 `taskLifecycle`，只暴露 `runtimeStatus` |
| 启动时机 | `PeriodicCheckRunner.start()` 后立即调用 `runOnceImmediately()` |
| 写入冲突 | 使用 `writeFileAtomicSync` |
| 错误恢复 | 损坏文件返回空 store |

---

## 参考

- Review 文档：`docs/design/team-status-review.md`
- 现有 registry：`src/agents/finger-system-agent/registry.ts`
- 现有 periodic-check：`src/agents/finger-system-agent/periodic-check.ts`
