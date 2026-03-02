# 编排者架构设计

## 1. 资源管理

### 1.1 执行者池（Executor Pool）
- 当前可用 executor 数量
- 当前可用 reviewer 数量
- 资源动态注册/发现

### 1.2 任务队列
- 阻塞任务队列（waiting for dependencies）
- 就绪任务队列（ready to execute）
- 执行中任务队列（in-progress）

### 1.3 任务分配策略
- 最大并行度控制
- 任务亲和性（相同 session 优先）
- 负载均衡

## 2. 流程管理

### 2.1 任务依赖图
```
Task A → Task B → Task D
      ↘ Task C ↗
```

### 2.2 状态机
- pending → ready → in_progress → completed/failed
- pending → blocked (waiting for deps)

### 2.3 流程编排
- 编排者生成 Workflow DAG
- 任务时间属性（est duration, deadline）
- 关键路径识别

## 3. 会话管理

### 3.1 Session 隔离
- 每个用户会话独立上下文
- 任务绑定 sessionId
- 默认恢复最近会话

### 3.2 Session 状态
- 创建/恢复/关闭
- 历史消息持久化
- 任务列表隔离

### 3.3 Session 存储
```
~/.finger/sessions/
  └── <project编码>/
      └── session-{sessionId}/
          ├── main.json
          └── agent-<agentId>.json
```

## 4. 数据结构

### 4.1 Workflow
```typescript
interface Workflow {
  id: string;
  sessionId: string;
  tasks: TaskNode[];
  dependencies: Dependency[];
  status: 'planning' | 'executing' | 'completed' | 'failed';
}
```

### 4.2 TaskNode
```typescript
interface TaskNode {
  id: string;
  type: 'executor' | 'reviewer';
  status: TaskStatus;
  dependencies: string[];  // task IDs
  dependents: string[];    // reverse refs
  assignee?: string;       // assigned agent ID
  estimatedDuration?: number;
  deadline?: number;
}
```

### 4.3 ResourcePool
```typescript
interface ResourcePool {
  executors: AgentResource[];
  reviewers: AgentResource[];
  maxParallel: number;
}
```
