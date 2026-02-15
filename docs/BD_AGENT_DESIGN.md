# Agent 与 bd 集成设计方案

## 目标

将 Agent 系统的任务状态、执行过程、交付物全部落盘到 bd，实现：
1. **任务可追溯** - 每个任务从创建到完成的完整生命周期在 bd 中可查
2. **状态可恢复** - daemon 重启后能从 bd 恢复任务状态
3. **协作可并行** - 多个 agent 通过 bd 协调，避免冲突

## 架构设计

### 1. 状态映射

| Agent 系统概念 | bd 概念 | 映射方式 |
|---------------|---------|---------|
| 编排会话 (Orchestration Session) | Epic | 1:1，一个用户任务对应一个 Epic |
| 子任务 (SubTask) | Task | 1:1，每个子任务是 Epic 的子 issue |
| 任务分配 (Assignment) | Assignment | 存储在 task 的 assignee 字段 |
| 执行结果 (Result) | Comment/Note | 关闭时写入 notes |
| 交付物 (Artifact) | File path in notes | 文件路径 + checksum |
| 执行者状态 (Agent Status) | Issue (type=agent) | 定期心跳更新 |

### 2. 核心组件

```
src/agents/shared/
├── bd-client.ts          # bd CLI 封装
├── bd-task-sync.ts       # 任务状态同步器
└── bd-types.ts           # 类型定义

src/agents/roles/
├── orchestrator.ts       # 集成 bd 创建/更新任务
└── executor.ts           # 集成 bd 更新执行状态
```

### 3. 状态机与 bd 同步

```
Orchestrator 状态机:

understanding ──bd:create(epic)──► planning ──bd:create(task)──► dispatching
       ▲                                                              │
       │                    ┌─────────────────────────────────────────┘
       │                    │
       └────bd:comment──────┴────bd:update(status)────► completing
       ▲                      (监控阶段持续更新)
       │
   replanning ◄──bd:create(change)── failed
```

### 4. bd 工具封装设计

```typescript
// src/agents/shared/bd-tools.ts

export interface BdTaskOptions {
  title: string;
  description?: string;
  type?: 'task' | 'epic' | 'bug' | 'review';
  parent?: string;        // parent issue id
  priority?: number;      // 0=urgent, 1=high, 2=normal
  assignee?: string;      // agent id
  labels?: string[];      // parallel, main-path, blocked
  acceptance?: string[];  // 验收标准
}

export interface BdTask {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'blocked' | 'review' | 'closed';
  assignee?: string;
  parent?: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export class BdTools {
  // 创建任务/Epic
  async createTask(options: BdTaskOptions): Promise<BdTask>;
  
  // 更新状态
  async updateStatus(taskId: string, status: BdTask['status']): Promise<void>;
  
  // 添加评论/进度
  async addComment(taskId: string, content: string): Promise<void>;
  
  // 关闭任务并记录交付物
  async closeTask(
    taskId: string, 
    reason: string, 
    deliverables?: Deliverable[]
  ): Promise<void>;
  
  // 创建依赖
  async addDependency(blocked: string, blocker: string): Promise<void>;
  
  // 查询可执行任务（无 blocker 的 open/in_progress）
  async getReadyTasks(): Promise<BdTask[]>;
  
  // 查询特定 agent 的任务
  async getTasksByAssignee(agentId: string): Promise<BdTask[]>;
  
  // 获取 Epic 进度
  async getEpicProgress(epicId: string): Promise<{
    total: number;
    completed: number;
    inProgress: number;
    blocked: number;
  }>;
}
```

### 5. Orchestrator 集成点

```typescript
// src/agents/roles/orchestrator.ts

class OrchestratorRole {
  private bdTools: BdTools;
  private currentEpic?: string;
  
  async startOrchestration(userTask: string): Promise<string> {
    // 1. 创建 Epic
    const epic = await this.bdTools.createTask({
      title: userTask,
      type: 'epic',
      priority: 0,
      labels: ['orchestration'],
    });
    this.currentEpic = epic.id;
    
    // 2. 进入 understanding 状态
    await this.bdTools.addComment(epic.id, 
      `[Orchestrator] 状态: understanding | 正在分析任务意图...`
    );
    
    return epic.id;
  }
  
  async decomposeTask(task: string): Promise<DecomposeResult> {
    // ... AI 拆解 ...
    
    // 为每个子任务创建 bd issue
    for (const subTask of tasks) {
      const bdTask = await this.bdTools.createTask({
        title: subTask.description,
        type: 'task',
        parent: this.currentEpic,
        priority: subTask.priority,
        labels: subTask.tools.includes('critical') ? ['main-path'] : ['parallel'],
        acceptance: [`完成: ${subTask.description}`],
      });
      subTask.bdTaskId = bdTask.id;
    }
    
    return { success: true, tasks };
  }
  
  async dispatchTask(task: TaskAssignment, executorId: string): Promise<void> {
    // 更新任务分配
    await this.bdTools.updateStatus(task.bdTaskId!, 'in_progress');
    await this.bdTools.addComment(task.bdTaskId!, 
      `[Orchestrator] 分配给执行者: ${executorId}`
    );
    
    // 实际派发...
  }
  
  async onTaskComplete(taskId: string, feedback: ExecutionFeedback): Promise<void> {
    if (feedback.success) {
      await this.bdTools.closeTask(
        taskId,
        '执行成功完成',
        [{ type: 'result', content: feedback.result }]
      );
    } else {
      await this.bdTools.updateStatus(taskId, 'blocked');
      await this.bdTools.addComment(taskId, 
        `[Orchestrator] 执行失败: ${feedback.observation}`
      );
    }
    
    // 更新 Epic 进度
    await this.updateEpicProgress();
  }
}
```

### 6. Executor 集成点

```typescript
// src/agents/roles/executor.ts

class ExecutorRole {
  private bdTools: BdTools;
  
  async claimTask(taskId: string): Promise<void> {
    await this.bdTools.updateStatus(taskId, 'in_progress');
    await this.bdTools.addComment(taskId, 
      `[${this.config.id}] 领取任务，开始执行`
    );
  }
  
  async executeTask(task: TaskAssignment): Promise<ExecutionResult> {
    await this.claimTask(task.bdTaskId!);
    
    // ReACT 循环中的状态更新
    const reactSteps: string[] = [];
    
    for (let i = 0; i < maxIterations; i++) {
      // Thought
      reactSteps.push(`[Step ${i}] Thought: ...`);
      await this.bdTools.addComment(task.bdTaskId!, 
        `执行进度: ${reactSteps.join('\n')}`
      );
      
      // Action...
      
      // Observation...
    }
    
    // 完成
    const result = await this.buildResult();
    await this.bdTools.closeTask(task.bdTaskId!, '执行完成', [
      { type: 'file', path: result.outputPath },
      { type: 'log', content: result.log },
    ]);
    
    return result;
  }
}
```

### 7. 会话持久化

```typescript
// src/agents/shared/session-persistence.ts

interface SessionSnapshot {
  sessionId: string;
  epicId: string;
  orchestratorState: OrchestratorState;
  context: OrchestratorContext;
  timestamp: Date;
}

export class SessionPersistence {
  private bdTools: BdTools;
  
  // 定期保存会话快照到 bd
  async saveSnapshot(session: SessionSnapshot): Promise<void> {
    const snapshotPath = `~/.finger/sessions/${session.sessionId}.json`;
    await fs.writeFile(snapshotPath, JSON.stringify(session, null, 2));
    
    await this.bdTools.addComment(session.epicId, 
      `[System] 会话快照已保存: ${snapshotPath}`
    );
  }
  
  // 从 bd 恢复会话
  async restoreSession(epicId: string): Promise<SessionSnapshot | null> {
    const tasks = await this.bdTools.getTasksByParent(epicId);
    // 根据任务状态重建上下文...
  }
}
```

### 8. CLI 集成

```bash
# 查看当前编排会话
finger orchestration status
# 输出: 当前 Epic, 已完成任务数, 进行中任务数

# 查看任务详情
finger task show <task-id>
# 输出: 任务状态、分配给谁、执行日志、交付物

# 手动触发重规划
finger orchestration replan <epic-id> --reason "需求变更"
```

## 实现优先级

1. **P0**: `BdTools` 基础封装 (`bd-client.ts`, `bd-task-sync.ts`)
2. **P0**: Orchestrator 集成 bd 创建/更新任务
3. **P1**: Executor 集成 bd 状态上报
4. **P1**: 会话持久化 (`session-persistence.ts`)
5. **P2**: CLI 查询命令

## 测试策略

1. **单元测试**: Mock bd CLI，测试工具封装
2. **集成测试**: 使用 `bd --no-db`，验证真实状态流转
3. **E2E 测试**: 完整编排循环，验证 bd 记录完整性
