# Project Agent Task Queue Design (V3)

> **Status**: Design Spec  
> **Scope**: Project Agent task queue, idle criteria, task switching logic  
> **Last updated**: 2026-04-07

---

## 0) 问题定义

**当前问题**：
1. Project Agent 只处理单个任务（`projectTaskState`），没有任务队列概念
2. Project Agent 进入 idle 的标准不清晰（缺少"task list 为空"检查）
3. 缺少任务切换逻辑：当前任务 `closed` 后，不会自动 pick next task

**V3 目标**：
- Project Agent 支持多任务队列
- idle 标准：**所有任务都被 System Agent close**
- 任务切换：按优先级 pick next task，不停止推理

---

## 1) 架构设计

### 1.1 数据结构

**Project Agent Task Queue**：

```typescript
interface ProjectAgentTaskQueue {
  /** 所有派发给 Project Agent 的任务 */
  registry: DelegatedProjectTaskRecord[];
  /** 当前正在执行的任务（active=true, status!=closed） */
  activeTasks: DelegatedProjectTaskRecord[];
  /** 当前优先执行的 taskId */
  currentTaskId?: string;
  /** 上一次任务关闭时间 */
  lastTaskClosedAt?: string;
}
```

**Task Registry 来源**：
- `session.context.projectTaskRegistry`：当前 session 的任务列表
- `parseDelegatedProjectTaskRegistry(rawRegistry)`：解析后的任务列表

### 1.2 idle 标准

**Project Agent 进入 idle 的条件**：

```typescript
function isProjectAgentIdle(queue: ProjectAgentTaskQueue): boolean {
  // 条件1：activeTasks 为空
  if (queue.activeTasks.length === 0) return true;
  
  // 条件2：所有任务的 status 都是 closed
  const allClosed = queue.activeTasks.every(
    task => task.status === 'closed'
  );
  return allClosed;
}
```

**单任务完成标准**：
- System Agent 调用 `project.approve_task(taskId)`
- 任务 status 从 `approved` → `closed`
- 任务 active=false

### 1.3 任务切换逻辑

**当前任务 closed 后的流程**：

```text
1. 检查 task list（activeTasks）
2. 如果 activeTasks.length > 0:
   - 按优先级排序（priority field 或 updatedAt）
   - pick next task
   - 切换到新任务
   - 继续推理（不 idle）
3. 如果 activeTasks.length === 0:
   - 进入 idle
   - 等待 System Agent 派发新任务
```

---

## 2) 实现位置

### 2.1 Kernel Agent Base

**文件**：`src/agents/base/kernel-agent-base.ts`

**当前逻辑**（L752）：
```typescript
const registry = parseDelegatedProjectTaskRegistry(rawRegistry);
const activeRegistry = registry.filter((item) => item.active === true);
```

**需要新增**：
- `resolveCurrentTask(queue)`：确定当前优先执行的 task
- `shouldSwitchToNextTask(queue, currentTaskId)`：判断是否需要切换

### 2.2 Heartbeat Scheduler

**文件**：`src/serverx/modules/heartbeat-scheduler.impl.ts`

**当前逻辑**（L1722-1723）：
```typescript
const state = this.resolveProjectTaskStateFromSession(projectSessionId);
if (!this.isActionableProjectTaskState(state, targetAgentId)) return false;
```

**需要新增**：
- `resolveProjectAgentTaskQueue(sessionId)`：获取 Project Agent 的任务队列
- `pickNextTaskForProjectAgent(queue)`：按优先级选下一个任务
- 在 heartbeat cycle 中检查：当前任务 closed → 是否有 next task → 切换

### 2.3 Project Status Gateway

**文件**：`src/server/modules/project-status-gateway.ts`

**需要新增**：
- `TRANSITION_MAP['closed']`：允许 closed → 状态保持
- `getActiveTasksForProjectAgent(registry)`：获取 Project Agent 的 active tasks

---

## 3) 状态机更新

**V3 状态流转**：

```text
System Agent dispatch → Project Agent task queue:
  - registry 增加 new task (status=dispatched)
  
Project Agent 接收任务:
  - status=accepted → in_progress
  
Project Agent 完成任务:
  - status=claimed_done → pending_review
  
System Agent 审核:
  - approve → status=approved → closed (active=false)
  - reject → status=rejected → in_progress
  
Project Agent 检查:
  - current task closed → check activeTasks
  - activeTasks.length > 0 → pick next task → continue
  - activeTasks.length === 0 → idle
```

---

## 4) 验证手段

### 4.1 测试场景

**场景1：多任务队列**
- System Agent 派发 3 个任务（task-1, task-2, task-3）
- Project Agent registry 应包含 3 个任务
- activeTasks 应包含 3 个任务（status!=closed）

**场景2：任务切换**
- task-1 被 approved → closed
- Project Agent 应自动切换到 task-2
- 不应进入 idle

**场景3：idle 标准**
- task-1, task-2, task-3 全部 closed
- Project Agent 应进入 idle
- activeTasks.length === 0

**场景4：reject 重做**
- task-1 被 rejected → in_progress
- Project Agent 应继续 task-1
- 不切换到 task-2

### 4.2 断言检查

```typescript
// 测试：多任务队列
expect(queue.registry.length).toBe(3);
expect(queue.activeTasks.length).toBe(3);

// 测试：任务切换
expect(queue.currentTaskId).toBe('task-2');
expect(queue.activeTasks.length).toBe(2);

// 测试：idle 标准
expect(isProjectAgentIdle(queue)).toBe(true);
expect(queue.activeTasks.length).toBe(0);
```

---

## 5) 优先级设计

**Task Priority 字段**：
- `priority: number`（可选，默认按 updatedAt 排序）
- priority 越高越优先执行

**排序逻辑**：
```typescript
function sortByPriority(tasks: DelegatedProjectTaskRecord[]): DelegatedProjectTaskRecord[] {
  return tasks.sort((a, b) => {
    // 优先级高的先执行
    if (a.priority !== undefined && b.priority !== undefined) {
      return b.priority - a.priority;
    }
    // 默认按 updatedAt（早的任务先执行）
    return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  });
}
```

---

## 6) 下一步

1. **Phase 1**：定义 `ProjectAgentTaskQueue` interface
2. **Phase 2**：实现 `resolveProjectAgentTaskQueue` 和 `pickNextTaskForProjectAgent`
3. **Phase 3**：在 heartbeat scheduler 中添加任务切换逻辑
4. **Phase 4**：更新 kernel-agent-base 的 context slot（显示 task queue）
5. **Phase 5**：编写测试场景

