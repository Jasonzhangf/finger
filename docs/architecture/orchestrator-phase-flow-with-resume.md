# 编排者阶段流转 + 状态恢复设计

## 1. 概述

本文档定义 Finger 编排者的完整阶段流转逻辑，包含任务中断后的状态恢复机制。

## 2. 阶段流转图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         编排者阶段流转                                │
└─────────────────────────────────────────────────────────────────────┘

[UNDERSTANDING] 理解任务
       │
       ▼
[HIGH_DESIGN] 概要设计 ─────────────────┐
       │                                │
       ▼                                │
[DETAIL_DESIGN] 详细设计                │
       │                                │
       ▼                                │
[DELIVERABLES] 交付清单定义             │
       │                                │
       ▼                                │
[PLAN] 任务拆解 ←───────────────────────┘ (设计迭代循环)
       │
       ├───► 生成 TaskGraph (任务依赖图)
       │
       ▼
[PARALLEL_DISPATCH] 并行派发
       │
       ├───► 识别非阻塞任务 (blockedBy=[])
       │       ├───► 并行派发给多个 Executor
       │       └───► 完成后回调
       │
       └───► 识别阻塞任务 (blockedBy≠[])
               └───► 加入 BlockedQueue 等待攻关
       │
       ▼
[BLOCKED_TASK_REVIEW] 阻塞任务审查
       │
       ├───► 获取最强力资源 (ResourcePool.getStrongest())
       │       └───► 分配最强 Executor 攻关
       │
       ▼
[VERIFY_DELIVERABLES] 交付物清点
       │
       ├───► 检查验收标准 (acceptanceCriteria)
       ├───► 检查测试报告 (testRequirements)
       └───► 检查交付物清单 (artifacts)
       │
       ├───► 通过 ──► [COMPLETE]
       │
       └───► 失败 ──► [REPLAN] ──► 回到 [HIGH_DESIGN]
       │
       ▼
[RESOURCE_RELEASE] 资源回收
       │
       └───► Agent 回空闲池
       │
       ▼
    [DONE]
```

## 3. 状态机定义

```typescript
type OrchestratorPhase =
  | 'understanding'      // 理解任务意图
  | 'high_design'        // 概要设计
  | 'detail_design'      // 详细设计
  | 'deliverables'       // 交付清单
  | 'plan'               // 任务拆解
  | 'parallel_dispatch'  // 并行派发
  | 'blocked_review'     // 阻塞任务审查
  | 'verify'             // 交付物验证
  | 'completed'
  | 'failed'
  | 'replanning';

// 阶段流转规则
const PHASE_TRANSITIONS: Record<OrchestratorPhase, OrchestratorPhase[]> = {
  understanding: ['high_design'],
  high_design: ['detail_design', 'replanning'],
  detail_design: ['deliverables', 'replanning'],
  deliverables: ['plan', 'replanning'],
  plan: ['parallel_dispatch', 'replanning'],
  parallel_dispatch: ['blocked_review', 'verify'],
  blocked_review: ['verify', 'replanning'],
  verify: ['completed', 'replanning'],
  completed: [],
  failed: ['replanning'],
  replanning: ['understanding', 'high_design'],
};
```

## 4. LoopState 增强定义

```typescript
interface LoopState extends ReActState {
  // === 基础信息 ===
  epicId: string;
  sessionId: string;
  userTask: string;
  
  // === 阶段管理 ===
  phase: OrchestratorPhase;
  phaseHistory: { phase: OrchestratorPhase; timestamp: string; action: string }[];
  
  // === 设计产出物 (可恢复) ===
  highDesign?: {
    architecture: string;
    techStack: string[];
    modules: string[];
    rationale?: string;
  };
  
  detailDesign?: {
    interfaces: string[];
    dataModels: string[];
    implementation: string;
  };
  
  deliverables?: {
    acceptanceCriteria: string[];
    testRequirements: string[];
    artifacts: string[];
  };
  
  // === 任务管理 (可恢复) ===
  taskGraph: TaskNode[];
  parallelTasks: string[];      // 非阻塞任务ID
  blockedTasks: string[];       // 阻塞任务ID
  completedTasks: string[];
  failedTasks: string[];
  
  // === Checkpoint 状态 ===
  checkpoint: {
    lastCheckpointId?: string;
    lastCheckpointAt?: string;
    autoSaveInterval: number;  // 自动保存间隔
    totalChecks: number;
    majorChange: boolean;
  };
  
  // === 恢复上下文 ===
  recoveryContext?: {
    fromCheckpoint: boolean;
    resumePhase: OrchestratorPhase;
    skipCompletedTasks: string[];
    retryFailedTasks: string[];
  };
}
```

## 5. Checkpoint 自动保存策略

```
┌──────────────────────────────────────────────────────────────────┐
│                    Checkpoint 自动保存点                          │
└──────────────────────────────────────────────────────────────────┘

[UNDERSTANDING] ────────► Checkpoint: phase=understanding
       │
       ▼
[HIGH_DESIGN] ──────────► Checkpoint: phase=high_design, highDesign={...}
       │
       ▼
[DETAIL_DESIGN] ────────► Checkpoint: phase=detail_design, detailDesign={...}
       │
       ▼
[DELIVERABLES] ─────────► Checkpoint: phase=deliverables, deliverables={...}
       │
       ▼
[PLAN] ─────────────────► Checkpoint: phase=plan, taskGraph=[...]
       │
       ▼
[PARALLEL_DISPATCH] ────► Checkpoint: 每完成一个任务
       │
       ▼
[BLOCKED_REVIEW] ───────► Checkpoint: 阻塞任务处理完成
       │
       ▼
[VERIFY] ───────────────► Checkpoint: 验证结果
       │
       ▼
    [DONE]
```

## 6. 恢复流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Session 恢复流程                            │
└─────────────────────────────────────────────────────────────────────┘

启动编排
    │
    ├─── 检查 sessionId 对应的 checkpoint
    │         │
    │         ├─── 找到最新 checkpoint
    │         │         │
    │         │         ▼
    │         │    loadCheckpoint()
    │         │         │
    │         │         ▼
    │         │    buildResumeContext()
    │         │         │
    │         │         ▼
    │         │    确定恢复阶段
    │         │         │
    │         │         ├─── phase=high_design → 从 HIGH_DESIGN 继续
    │         │         ├─── phase=plan → 从 PLAN 继续，跳过已完成任务
    │         │         ├─── phase=parallel_dispatch → 恢复任务状态继续派发
    │         │         └─── phase=verify → 重新验证交付物
    │         │
    │         └─── 无 checkpoint
    │                   │
    │                   ▼
    │              从 UNDERSTANDING 开始
    │
    ▼
执行阶段流转
    │
    ├─── 每个阶段完成后 saveCheckpoint()
    │
    └─── 任务完成后 cleanupOldCheckpoints()
```

## 7. 阶段恢复映射表

| 中断阶段 | 恢复策略 | 跳过项 | 重试项 |
|---------|---------|--------|--------|
| `understanding` | 从头开始 | 无 | 无 |
| `high_design` | 重新评估设计 | 无 | 无 |
| `detail_design` | 基于已保存的高层设计继续 | highDesign | 无 |
| `deliverables` | 基于已保存的详细设计继续 | highDesign, detailDesign | 无 |
| `plan` | 重新生成任务图，保留设计 | highDesign, detailDesign, deliverables | 无 |
| `parallel_dispatch` | 跳过已完成任务，继续派发 | completedTasks | in_progress |
| `blocked_review` | 重新评估阻塞任务 | completedTasks | blockedTasks |
| `verify` | 重新验证交付物 | all tasks | 无 |

## 8. 关键算法

### 8.1 任务分类算法

```typescript
function classifyTasks(tasks: TaskNode[]): { parallel: string[], blocked: string[] } {
  const parallel = tasks.filter(t => !t.blockedBy || t.blockedBy.length === 0).map(t => t.id);
  const blocked = tasks.filter(t => t.blockedBy && t.blockedBy.length > 0).map(t => t.id);
  return { parallel, blocked };
}
```

### 8.2 并行派发算法

```typescript
async function parallelDispatch(tasks: string[], state: LoopState): Promise<void> {
  const promises = tasks.map(taskId => 
    state.hub.sendToModule(state.targetExecutorId, { taskId, description: getTaskDesc(taskId) })
  );
  const results = await Promise.allSettled(promises);
  // 处理结果，更新 taskGraph
}
```

### 8.3 阻塞任务攻关算法

```typescript
async function tackleBlockedTasks(state: LoopState, resourcePool: ResourcePool): Promise<void> {
  for (const taskId of state.blockedTasks) {
    const strongestResource = resourcePool.getStrongestAvailable();
    if (strongestResource) {
      resourcePool.deployResource(strongestResource.id, state.sessionId);
      // 派发任务给最强资源
    }
  }
}
```

### 8.4 交付物清点算法

```typescript
async function verifyDeliverables(state: LoopState): Promise<VerificationResult> {
  const { acceptanceCriteria, testRequirements, artifacts } = state.deliverables!;
  
  const missingArtifacts = artifacts.filter(a => !checkArtifactExists(a));
  const failedTests = await runTests(testRequirements);
  
  return {
    passed: missingArtifacts.length === 0 && failedTests.length === 0,
    missingDeliverables: missingArtifacts,
    failedTests,
  };
}
```

### 8.5 确定恢复阶段算法

```typescript
function determineResumePhase(checkpoint: SessionCheckpoint): OrchestratorPhase {
  // 如果有失败任务，从 plan 阶段重新评估
  if (checkpoint.failedTaskIds.length > 0) {
    return 'plan';
  }
  
  // 如果有进行中任务，从 parallel_dispatch 继续
  const inProgress = checkpoint.taskProgress.filter(t => t.status === 'in_progress');
  if (inProgress.length > 0) {
    return 'parallel_dispatch';
  }
  
  // 如果全部完成，进入 verify
  if (checkpoint.pendingTaskIds.length === 0) {
    return 'verify';
  }
  
  // 否则从上次保存的阶段继续
  return (checkpoint.context.phase as OrchestratorPhase) || 'understanding';
}
```

## 9. 文件位置

- 实现文件: `src/agents/daemon/orchestrator-loop.ts`
- 状态管理: `src/orchestration/resumable-session.ts`
- Actions 定义: `src/agents/core/action-registry-simple.ts`
- Checkpoint 存储: `~/.finger/session-states/`

## 10. 相关任务

- BD: finger-40 (修复连接状态)
- BD: finger-45 (Calculator App)
- BD: finger-54 (五子棋应用)

---
*文档版本: 1.0*
*创建日期: 2026-02-18*