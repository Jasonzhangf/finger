# Agent Context 设计文档

## 概述

Agent Context 是提供给每个 Agent 的标准化上下文信息，包含资源池状态、能力目录、任务信息等，用于支持基于能力的任务分配和执行。

## 标准上下文结构

```typescript
interface AgentContext {
  /** 当前时间戳 */
  timestamp: string;
  
  /** 资源池状态 */
  resourcePool: ResourcePoolSummary;
  
  /** 可用能力列表（仅 available > 0 的能力） */
  availableCapabilities: string[];
  
  /** 能力 - 资源映射（快速查找） */
  capabilityToResources: Record<string, string[]>;
  
  /** 任务相关信息（可选，派发任务时填充） */
  task?: {
    id: string;
    description: string;
    requiredCapabilities?: string[];
    bdTaskId?: string;
  };
  
  /** 编排者指令（可选） */
  orchestratorNote?: string;
}
```

## 上下文生成流程

### 1. 编排者启动时

```typescript
// 构建初始上下文
const initialContext = buildAgentContext();
const dynamicPrompt = generateDynamicSystemPrompt(basePrompt, initialContext);

// 使用动态提示词创建 Agent
const agent = new Agent({
  systemPrompt: dynamicPrompt,
  // ...
});
```

### 2. 派发任务时

```typescript
// 为每个任务构建特定上下文
const taskContext = buildAgentContext({
  taskId: 'task-1',
  taskDescription: '搜索 DeepSeek 论文',
  requiredCapabilities: ['web_search'],
  bdTaskId: 'finger-60.1',
  orchestratorNote: '请使用 executor-research 执行此任务',
});

// 发送给执行者
hub.sendToModule(targetExecutorId, {
  taskId,
  description,
  bdTaskId,
  context: taskContext, // 包含上下文
});
```

### 3. 执行者接收任务时

```typescript
// 执行者收到任务后，刷新自己的上下文
const taskContext = buildAgentContext({
  taskId,
  taskDescription: description,
  bdTaskId,
  orchestratorNote: context?.orchestratorNote,
});
const dynamicPrompt = generateDynamicSystemPrompt(config.systemPrompt, taskContext);
agent.systemPrompt = dynamicPrompt;
```

## 系统提示词动态生成

### 基础提示词 + 上下文 = 动态提示词

```typescript
function generateDynamicSystemPrompt(basePrompt: string, context: AgentContext): string {
  const contextSection = contextToSystemPrompt(context);
  return `${basePrompt}\n\n${contextSection}`;
}
```

### 上下文提示词示例

```markdown
## 当前资源池状态
- 总资源数：5
- 可用：3
- 忙碌：2
- 错误：0

## 可用能力目录

| 能力 | 可用资源数 | 总资源数 | 可用资源 ID |
|------|-----------|---------|------------|
| web_search | 1 | 2 | executor-research |
| file_ops | 2 | 3 | executor-general, executor-coding |
| code_generation | 1 | 1 | executor-coding |
| report_generation | 1 | 2 | executor-research |

## 当前任务
- ID: task-1
- 描述：搜索 DeepSeek 论文
- 所需能力：web_search

## 编排者指令
请使用 executor-research 执行此任务，已分配资源：executor-research
```

## 能力 - 工具映射

Agent 的能力由其拥有的工具决定：

| 能力 | 所需工具 |
|------|---------|
| web_search | web_search |
| file_ops | read_file, write_file |
| code_generation | code_generation_tool |
| shell_exec | shell_exec |
| report_generation | report_generator |

## 动态工具赋予

未来支持：

1. **创建定时任务资源**
   ```typescript
   resourcePool.addResource({
     id: 'scheduler-1',
     type: 'tool',
     capabilities: [{ type: 'schedule_task', level: 8 }],
   });
   ```

2. **将工具派发给 Agent**
   ```typescript
   agent.grantTool('schedule_task');
   ```

3. **Agent 获得新能力**
   ```typescript
   // 能力目录自动更新
   const catalog = resourcePool.getCapabilityCatalog();
   // schedule_task 现在可用
   ```

4. **资源池自动更新**
   - 能力目录实时反映当前状态
   - 每次任务派发前刷新上下文

## 使用场景

### 场景 1：编排者任务分配

编排者查看能力目录，决定任务分配：

```
用户任务：研究 DeepSeek 技术趋势

编排者思考：
- 需要 web_search 能力 → executor-research 可用
- 需要 report_generation 能力 → executor-research 可用
- 决定：将任务分配给 executor-research
```

### 场景 2：执行者任务执行

执行者收到任务和上下文：

```
任务上下文：
- 所需能力：web_search
- 已分配资源：executor-research
- 编排者指令：使用 executor-research 执行

执行者思考：
- 我拥有 web_search 工具
- 我可以执行此任务
- 开始搜索...
```

### 场景 3：资源不足报告

编排者发现资源不足：

```
能力目录：
- web_search: 0/1 (busy)

决策：
- 资源不足，无法派发
- 发送 STOP 命令，报告缺乏 web_search 能力
- 等待资源释放或用户添加新资源
```

## API 参考

### buildAgentContext

```typescript
function buildAgentContext(options?: {
  taskId?: string;
  taskDescription?: string;
  requiredCapabilities?: string[];
  bdTaskId?: string;
  orchestratorNote?: string;
}): AgentContext
```

### generateDynamicSystemPrompt

```typescript
function generateDynamicSystemPrompt(
  basePrompt: string,
  context: AgentContext
): string
```

### contextToSystemPrompt

```typescript
function contextToSystemPrompt(context: AgentContext): string
```

### getResourcePoolSummary

```typescript
function getResourcePoolSummary(): ResourcePoolSummary
```
