# 资源池设计文档

## 概述

Finger 项目采用基于资源池的任务派发机制，确保任务执行具备所需资源，支持资源类别匹配、临时占用和释放。

## 核心概念

### 资源类型 (ResourceType)

| 类型 | 说明 | 典型能力 |
|------|------|---------|
| `executor` | 任务执行者 | web_search, file_ops, code_generation, shell_exec |
| `orchestrator` | 任务编排者 | planning, coordination |
| `reviewer` | 质量审查者 | code_review, quality_check |
| `tool` | 工具资源 | specific_tool_access |
| `api` | API 资源 | external_api_access |
| `database` | 数据库资源 | db_connection |

### 资源状态 (ResourceStatus)

- `available`: 可用，未分配
- `deployed`: 已分配给任务，等待执行
- `busy`: 正在执行任务
- `blocked`: 资源阻塞（等待依赖释放）
- `error`: 错误状态，需要人工干预
- `released`: 已释放，等待回收

### 任务资源分配 (TaskResourceAllocation)

每个任务在执行前需要分配资源：
```typescript
{
  taskId: "task-1",
  allocatedResources: ["executor-research", "api-bing"],
  status: "allocated" | "executing" | "completed" | "blocked" | "failed",
  blockedReason?: "resource_shortage" | "dependency_not_ready",
}
```

## 工作流程

### 1. 任务拆解与资源需求推断

编排者拆解任务时，根据任务描述推断资源需求：

```typescript
function inferResourceRequirements(description: string): ResourceRequirement[] {
  // 搜索类任务 → executor (web_search)
  // 代码类任务 → executor (code_generation)
  // 文件类任务 → executor (file_ops)
  // 报告类任务 → executor (report_generation)
}
```

### 2. 资源分配检查

派发任务前，检查资源池是否满足需求：

```typescript
const check = resourcePool.checkResourceRequirements(requirements);
if (!check.satisfied) {
  // 资源不足，进入 BLOCKED 状态
  return {
    success: false,
    error: `资源不足：缺少 ${check.missingResources.map(r => r.type).join(', ')}`,
    missingResources: check.missingResources,
  };
}
```

### 3. 资源分配与锁定

资源满足时，分配并锁定资源：

```typescript
const allocation = resourcePool.allocateResources(taskId, requirements);
// 资源状态变为 'deployed'
```

### 4. 任务执行与资源释放

任务完成后，释放资源回池：

```typescript
resourcePool.releaseResources(taskId, 'completed');
// 资源状态变回 'available'
```

## 资源缺乏处理

### 场景 1：可恢复的资源缺乏

某些资源可能暂时被占用，等待释放后可恢复：

```json
{
  "action": "STOP",
  "params": {"reason": "等待 executor-research 资源释放"}
}
```

**处理流程**：
1. 编排者进入 `paused` 状态
2. 等待资源释放
3. 用户发送 `START` 命令
4. 重新检查资源，恢复派发

### 场景 2：不可恢复的资源缺乏

某些资源不存在或永久不可用：

```json
{
  "action": "STOP",
  "params": {"reason": "资源缺乏：缺少 executor-research 类型资源"}
}
```

**处理流程**：
1. 编排者进入 `blocked_review` 状态
2. 报告用户缺乏的资源类型
3. **等待用户添加资源**
4. 用户发送 `START` 命令
5. 重新检查资源，恢复派发

## 资源池 API

### 检查资源需求

```typescript
resourcePool.checkResourceRequirements(requirements: ResourceRequirement[]): {
  satisfied: boolean;
  missingResources: ResourceRequirement[];
  availableResources: ResourceInstance[];
}
```

### 分配资源

```typescript
resourcePool.allocateResources(
  taskId: string,
  requirements: ResourceRequirement[]
): {
  success: boolean;
  allocatedResources?: string[];
  error?: string;
  missingResources?: ResourceRequirement[];
}
```

### 释放资源

```typescript
resourcePool.releaseResources(taskId: string, reason?: string): boolean
```

### 获取状态报告

```typescript
resourcePool.getStatusReport(): {
  totalResources: number;
  available: number;
  deployed: number;
  busy: number;
  blocked: number;
  error: number;
}
```

## 多资源属性实体

一个实体可以具备多个资源属性：

```typescript
{
  id: "executor-fullstack",
  name: "Fullstack Executor",
  type: "executor",
  capabilities: [
    { type: "web_search", level: 8 },
    { type: "code_generation", level: 9 },
    { type: "file_ops", level: 10 },
    { type: "report_generation", level: 7 },
  ]
}
```

**资源占用规则**：
- 一个实体同时只能执行一个任务
- 任务完成后必须释放所有资源属性
- 如果任务失败，资源进入 `error` 状态，需要人工干预

## 最佳实践

### 1. 合理配置资源池

根据任务类型预配置资源：
```typescript
// 研究密集型任务
resourcePool.addResource({
  id: 'executor-research-1',
  type: 'executor',
  capabilities: [
    { type: 'web_search', level: 10 },
    { type: 'data_analysis', level: 9 },
  ]
});
```

### 2. 任务拆解时考虑资源

拆解任务时明确标注资源需求：
- ✅ "使用 executor-research 搜索 DeepSeek 论文"
- ❌ "搜索 DeepSeek 论文"（未指定资源）

### 3. 及时释放资源

任务完成后立即释放资源，避免资源泄漏。

### 4. 监控资源状态

定期检查资源池状态，发现瓶颈：
```typescript
const status = resourcePool.getStatusReport();
if (status.blocked > 0) {
  console.warn(`警告：${status.blocked} 个资源被阻塞`);
}
```
