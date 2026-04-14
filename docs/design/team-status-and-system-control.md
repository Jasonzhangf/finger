# Team Status & System Agent Control 设计

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
  projectId: string;
  projectPath: string;
  role: 'system' | 'project';
  
  // Runtime 状态（来自 runtime_view）
  runtimeStatus: 'idle' | 'running' | 'queued' | 'waiting_input' | 'paused' | 'failed' | 'stopped';
  lastDispatchId?: string;
  lastTaskId?: string;
  lastTaskName?: string;
  
  // Plan 进度（来自 update_plan）
  planSummary?: {
    total: number;
    completed: number;
    inProgress: number;
    blocked: number;
    currentStep?: string;
    updatedAt: string;
  };
  
  // Task 生命周期（来自 projectTaskState）
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
  viewerRole: 'system' | 'project'
): TeamAgentStatus[] {
  const allAgents = Object.values(store.agents);
  
  if (viewerRole === 'system') {
    // System Agent 看到全部
    return allAgents;
  }
  
  // Project Agent：
  // 1. 看到同 project 内的其他 agents
  // 2. 看到 System Agent 的闲忙状态（只看 runtimeStatus）
  return allAgents.filter(agent => {
    if (agent.role === 'system') {
      return true; // System Agent 总可见，但只返回 runtimeStatus
    }
    return agent.projectPath === viewerProjectPath;
  }).map(agent => {
    if (agent.role === 'system') {
      // System Agent 只返回 runtimeStatus，不暴露 task/plan 详情
      return {
        agentId: agent.agentId,
        projectId: agent.projectId,
        projectPath: agent.projectPath,
        role: 'system',
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
  agentId?: string;  // update 时指定自己的 agentId
  planSummary?: {    // update 时传入 plan 进度
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
  agents?: TeamAgentStatus[];  // status 返回可见范围内的 agents
  self?: TeamAgentStatus;      // update 返回更新后的自己状态
  error?: string;
}
```

工具名称：`team.status`（提供 `status` 和 `update` 两个 action）

### 4. update_plan 同步机制

在 `codex-update-plan-tool.ts` 中，每次 `update_plan` 成功后：
1. 计算 planSummary（total/completed/inProgress/blocked）
2. 调用 `syncTeamStatusFromPlan(agentId, projectPath, planSummary)`
3. 写入 `~/.finger/system/team-status.json`

```typescript
function syncTeamStatusFromPlan(
  agentId: string,
  projectPath: string,
  planSummary: PlanSummary
): void {
  const store = loadTeamStatusStore();
  const now = new Date().toISOString();
  
  const existing = store.agents[agentId];
  store.agents[agentId] = {
    ...existing,
    agentId,
    projectPath,
    planSummary: {
      ...planSummary,
      updatedAt: now,
    },
    updatedAt: now,
  };
  
  persistTeamStatusStore(store);
}
```

### 5. PeriodicCheckRunner 同步机制

在 `periodic-check.ts` 的 `runOnce()` 中：
1. 获取 runtime_view（所有 agents 的 runtimeStatus）
2. 遍历每个 agent，更新 team-status.json 的 runtimeStatus 字段
3. System Agent 同时更新自己的 planSummary

```typescript
async runOnce(): Promise<void> {
  const runtimeView = await this.deps.agentRuntimeBlock.execute('runtime_view', {});
  const agents = runtimeView.agents;
  const store = loadTeamStatusStore();
  
  for (const agent of agents) {
    const agentId = agent.id;
    const status = agent.status;
    
    store.agents[agentId] = {
      ...store.agents[agentId],
      agentId,
      runtimeStatus: status,
      lastDispatchId: agent.lastEvent?.dispatchId,
      lastTaskId: agent.lastEvent?.taskId,
      lastTaskName: agent.lastEvent?.taskName,
      updatedAt: new Date().toISOString(),
    };
  }
  
  persistTeamStatusStore(store);
  
  // 原有的 registry 更新和 heartbeat 发送逻辑...
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
    → startSystemAgent()  ← 只启动 System Agent
    → PeriodicCheckRunner.start()  ← PeriodicCheck 决定启动 Project Agent

PeriodicCheckRunner.runOnce():
  1. 检查 runtime_view（当前已启动的 agents）
  2. 检查 registry（需要 monitored 的 agents）
  3. 对比：如果 monitored agent 未启动 → 启动它
  4. 对比：如果 monitored agent 已失败 → 重启它
  5. 更新 team-status.json
  6. 对 idle monitored agents 发送 heartbeat prompt
```

### SystemAgentManager 修改

```typescript
// src/serverx/modules/system-agent-manager.impl.ts

async start(): Promise<void> {
  await this.startSystemAgent();
  // 移除 startMonitoredProjects()
  this.periodicCheckRunner.start();
}

// PeriodicCheckRunner 新增启动逻辑
async runOnce(): Promise<void> {
  const runtimeView = await this.deps.agentRuntimeBlock.execute('runtime_view', {});
  const registryAgents = await listAgents();
  const monitoredAgents = registryAgents.filter(a => a.monitored);
  
  const runningAgentIds = new Set(
    runtimeView.agents.map(a => a.id)
  );
  
  // 启动未运行的 monitored agents
  for (const agent of monitoredAgents) {
    if (!runningAgentIds.has(agent.agentId)) {
      await this.startProjectAgent(agent);
    }
  }
  
  // 更新 team status
  // ...
}
```

---

## 文件修改清单

### 新增文件

| 文件路径 | 说明 |
|---------|------|
| `src/common/team-status-state.ts` | TeamStatus 数据结构 + load/persist 函数 |
| `src/tools/internal/team-status-tool.ts` | team.status 工具实现 |
| `tests/unit/tools/team-status.test.ts` | team.status 工具测试 |

### 修改文件

| 文件路径 | 修改内容 |
|---------|---------|
| `src/tools/internal/codex-update-plan-tool.ts` | 每次 update 后调用 syncTeamStatusFromPlan |
| `src/agents/finger-system-agent/periodic-check.ts` | 1. 检查并启动未运行的 monitored agents；2. 更新 team-status.json |
| `src/serverx/modules/system-agent-manager.impl.ts` | 移除 startMonitoredProjects()，只启动 System Agent |
| `src/agents/base/kernel-agent-base.ts` | 新增 `task.team_status` context slot |
| `src/agents/chat-codex/agent-role-config.ts` | 注册 team.status 工具 |

---

## 测试计划

### 单元测试

1. `team-status-state.ts`：
   - loadTeamStatusStore：空文件/已有数据/损坏文件
   - persistTeamStatusStore：写入/原子写入
   - filterTeamStatusByScope：system scope / project scope

2. `team-status-tool.ts`：
   - status action：system agent 看到 all / project agent 看到 scope 内
   - update action：更新自己的 planSummary

3. `periodic-check.ts`：
   - runOnce：启动未运行的 monitored agent
   - runOnce：重启失败的 monitored agent

### 集成测试

1. 启动流程：
   - daemon 启动 → 只有 System Agent 运行
   - PeriodicCheck → 启动 monitored Project Agent

2. 状态同步：
   - Project Agent update_plan → team.status 更新
   - System Agent team.status → 看到 Project Agent 的 plan 进度

---

## 待确认问题

1. **team.status 工具的权限**：
   - Project Agent 是否可以调用 update action？（只能更新自己）
   - 还是只有 PeriodicCheckRunner 可以更新 runtimeStatus？

2. **System Agent 的 plan 显示**：
   - System Agent 的 plan 是否需要对 Project Agent 隐藏？
   - 还是只隐藏 taskLifecycle 详情？

3. **启动时机**：
   - PeriodicCheckRunner 的首次 runOnce 是否立即执行？
   - 还是等待第一个 interval（5 分钟）？

