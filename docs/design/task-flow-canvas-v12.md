# TaskFlow Canvas v12 设计文档

> 目标：基于循环生命周期的三区分区可视化编排流程
> 参考：`/tmp/finger-ui-demo-v12.html`
> 关联：[资源驱动编排架构 v2](./resource-driven-orchestration-v2.md)

---

## 1. 核心概念

### 1.1 Epic 生命周期三阶段

每个 Epic 任务经历三个阶段：

```
┌────────────┐     ┌──────────────┐     ┌──────────────┐
│   Plan     │ --> │ Detail       │ --> │  Execution   │ --> 完成
│   阶段     │     │ Design       │     │   阶段       │
└────────────┘     └──────────────┘     └──────────────┘
    │                   │                    │
    v                   v                    v
[用户参与]          [审核门]            [资源池驱动]
```

- **Plan 阶段**: 需求分析 → 概要设计 → 用户确认
- **Detail Design 阶段**: 详细设计 → 审核门 → 任务分解
- **Execution 阶段**: 任务执行 → 资源分配/释放 → 循环推进

### 1.2 循环（Loop）
每个阶段由一个或多个循环组成：
- **编排门（orch）**: 任务分解与变更决策
- **审核门（review）**: 质量检查与交付审批
- **执行节点（exec）**: Agent 具体执行任务
- **用户节点（user）**: 用户交互与确认（仅 Plan 阶段）

### 1.3 循环生命周期
```
排队 (queue) → 执行中 (running) → 历史 (history)
                     ↓
             成功/失败触发编排变更
                     ↓
             生成新循环进入排队
```

---

## 2. 界面布局（三区分区）

### 2.1 顶部：历史区（History Zone）
- **内容**: 已完成（成功/失败）的循环
- **展示**: 横向卡片，每个卡片是一个循环的节点缩略图
- **交互**: 点击查看完整循环详情
- **视觉**: 成功=绿色边框，失败=红色边框

### 2.2 中部：执行区（Running Zone）
- **内容**: 当前正在执行的循环
- **展示**: 每个任务一行，节点从左向右生长
- **节点类型**:
  - 🔵 编排门（蓝色）
  - 🟣 审核门（紫色）
  - 🟢 执行节点（绿色）
  - 🟡 用户节点（黄色）
- **连线**: 箭头表示流向，`→` 正常，`✗` 失败回退
- **生长动画**: 新节点从右侧滑入

### 2.3 底部：排队区（Queue Zone）
- **内容**: 等待执行的循环（由编排变更生成）
- **展示**: 卡片形式，显示来源循环ID
- **状态**: 淡色半透明，表示等待中

---

## 3. 数据结构

### 3.1 循环

```typescript
interface Loop {
 id: string;           // L-{epicId}-{phase}-{seq}
 epicId: string;       // 所属 Epic
 phase: 'plan' | 'design' | 'execution';
 status: 'queue' | 'running' | 'history';
 result?: 'success' | 'failed';
 nodes: LoopNode[];
 createdAt: string;
 completedAt?: string;
}
```

### 3.2 循环节点

```typescript
interface LoopNode {
 id: string;
 type: 'orch' | 'review' | 'exec' | 'user';
 status: 'waiting' | 'running' | 'done' | 'failed';
 title: string;
 text: string;
 agentId?: string;
 userId?: string;
 timestamp: string;

 resourceAllocation?: {
   allocated: string[];
   released?: string[];
 };
}
```

### 3.3 任务流（Epic 级别）

```typescript
interface TaskFlow {
 id: string;           // Epic ID
 title: string;
 status: 'plan' | 'design' | 'execution' | 'completed' | 'failed';

 planHistory: Loop[];
 designHistory: Loop[];
 executionHistory: Loop[];

 runningLoop?: Loop;
 queue: Loop[];
}
```

---

## 4. 状态流转规则

### 4.1 Plan 阶段循环

```
用户输入 → 编排(需求分析) → 审核 → [用户确认] → 编排(概要设计) → 审核
   ↑                                                           │
   └────────────── 用户拒绝/需要澄清 ←───────────────────────────┘
```

**退出条件**: 用户确认概要设计 → 进入 Detail Design

### 4.2 Design 阶段循环

```
编排(详细设计) → 审核 → [审核门] → 编排(任务分解) → 审核
   ↑                                               │
   └────────────── 审核拒绝 ←──────────────────────┘
```

**退出条件**: 审核门通过 → 任务进入执行队列

### 4.3 Execution 阶段循环

```
编排(资源分配) → 执行任务 → 审核(交付检查) → 释放资源
   ↑                                               │
   └────────────── 审核拒绝/执行失败 ←──────────────┘
```

**退出条件**: 所有任务完成 → Epic 完成

### 4.4 资源驱动执行

每个 exec 节点：
1. 从资源池获取资源（`resourcePool.allocateResources()`）
2. 执行任务
3. 释放资源（`resourcePool.releaseResources()`）
4. 编排 Agent 恢复为可用资源

---

## 5. WebSocket 事件协议

### 5.1 循环事件
```typescript
{ type: 'loop.created', epicId: string, payload: { loop: Loop } }
{ type: 'loop.started', epicId: string, loopId: string, payload: { loopId: string, phase: LoopPhase } }
{ type: 'loop.node.updated', epicId: string, loopId: string, nodeId: string, payload: { node: LoopNode } }
{ type: 'loop.node.completed', epicId: string, loopId: string, nodeId: string, payload: { result: 'success' | 'failed' } }
{ type: 'loop.completed', epicId: string, payload: { loop: Loop, result: 'success' | 'failed' } }
{ type: 'loop.queued', epicId: string, payload: { loop: Loop, sourceLoopId: string } }
```

### 5.2 资源事件
```typescript
{ type: 'resource.allocated', taskId: string, payload: ResourceAllocationInfo }
{ type: 'resource.released', taskId: string, payload: { resources: string[], reason: string } }
```

### 5.3 阶段事件
```typescript
{ type: 'epic.phase_transition', epicId: string, payload: { from, to, reason } }
{ type: 'epic.user_input_required', epicId: string, payload: PendingUserInput }
```

### 5.4 分组订阅
UI 订阅 `TASK`、`RESOURCE`、`HUMAN_IN_LOOP` 分组。

---

## 6. 对话面板时间线

### 6.1 按循环分组呈现

```typescript
interface DialogTimeline {
 epicId: string;
 loops: Array<{
   loopId: string;
   phase: 'plan' | 'design' | 'execution';
   status: 'running' | 'history';
   messages: Array<{
     role: 'user' | 'agent' | 'system';
     agentId?: string;
     content: string;
     timestamp: string;
     nodeId?: string;
     nodeType?: 'orch' | 'review' | 'exec' | 'user';
   }>;
 }>;
}
```

### 6.2 展示逻辑
1. 当前循环置顶
2. 历史循环折叠
3. 消息与节点双向关联
4. WebSocket 实时追加

---

## 7. 组件结构

```
ui/src/components/TaskFlowCanvas/
├── TaskFlowCanvas.tsx
├── HistoryZone.tsx
├── RunningZone.tsx
├── QueueZone.tsx
├── LoopRow.tsx
├── LoopNode.tsx
├── Arrow.tsx
├── types.ts
└── hooks/useTaskFlow.ts
```

```
ui/src/components/ChatInterface/
├── ChatInterface.tsx
├── DialogTimeline.tsx
├── LoopGroup.tsx
├── MessageItem.tsx
├── ChatInput.tsx
└── types.ts
```

---

## 8. 与现有系统集成

### 8.1 Backend
- 新增 `src/orchestration/loop/`
- 通过 `globalEventBus` 发射循环/资源/阶段事件

### 8.2 Frontend
- `useWorkflowExecution` 消费新事件协议
- `TaskFlowCanvas` 替换旧 OrchestrationCanvas 的数据模型
- 对话面板按循环聚合显示

---

## 9. 实现优先级

| 优先级 | 内容 | 验收标准 |
|--------|------|----------|
| P0 | Backend: ���环事件协议与数据结构 | TypeScript 编译通过 |
| P0 | Backend: LoopManager 生命周期 | 可创建/推进/完成循环 |
| P0 | Frontend: 三区分区组件 | 静态+实时数据可渲染 |
| P0 | Frontend: 对话按循环分组 | 可见完整时间线 |
| P1 | 资源分配可视化 | 节点显示占用/释放 |
| P2 | 会话压缩可视化 | 显示压缩触发与结果 |

---

## 10. 设计决策

| 决策 | 选择 |
|------|------|
| Epic 并行 | 并行预留，单实例先落地 |
| 压缩触发 | 双条件（循环完成 + token 阈值） |
| 对话组织 | 按循环而非纯时间流 |
| 资源模型 | 资源即能力，统一输入输出契约 |

---

> 下一阶段：实现 Orchestrator/Executor 对 LoopManager 的接入。
