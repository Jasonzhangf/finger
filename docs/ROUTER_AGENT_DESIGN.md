# Router Agent - 语义路由控制器设计文档

## 概述

Router Agent 是用户输入的第一道关卡，负责：
1. 接收所有用户输入
2. 调用 LLM 分析用户意图
3. 根据意图路由到正确的处理 Agent

## 架构图

```
用户输入
    ↓
┌─────────────────┐
│  Router Agent   │ ← 第一道关卡
│  (语义分析)     │
└────────┬────────┘
         │
    ┌────┴────┐
    │ 意图判断 │
    └────┬────┘
         │
    ┌────┴────────────────────┐
    │                         │
┌───▼────┐            ┌──────▼──────┐
│ Chat   │            │   Task      │
│ Agent  │            │ Orchestrator│
│        │            │             │
│ 通用问答│            │ 任务编排执行│
└────────┘            └─────────────┘
```

## 路由规则

### 1. Chat Route（通用问答）
**触发条件：**
- 用户询问通用知识、概念解释
- 闲聊、打招呼
- 与当前项目文件夹内容无关的问题

**目标模块：** `chat-agent`

**示例：**
- "什么是 TypeScript？"
- "今天天气怎么样？"
- "介绍一下 React hooks"

### 2. Task Route（任务执行）
**触发条件：**
- 要求执行具体操作
- 修改代码、创建文件
- 与当前项目相关的任务

**目标模块：** `task-orchestrator`

**示例：**
- "帮我创建一个新组件"
- "修复这个 bug"
- "运行测试"

## 工作流程

### 完整流程

```typescript
1. 用户输入 → router-input
2. Router Agent 接收消息
3. 构建 Prompt 调用 LLM
4. LLM 返回意图分析结果
5. Router 解析结果并决策
6. 路由到目标模块 (chat/task)
7. 目标模块处理并返回结果
8. Router 输出最终结果
```

### 失败处理

如果 LLM 调用失败，使用**规则 fallback**：
- 检测任务关键词（创建、修改、删除、代码、文件等）
- 默认路由到 task

## 配置

```typescript
interface RouterConfig {
  id: 'router-agent';
  modelProvider: 'iflow';
  modelId: 'gpt-4';
  systemPrompt: string;  // 意图分析提示词
  routes: RouteRule[];   // 路由规则列表
}
```

## 扩展性

### 添加新路由方向

1. 在 `routes` 数组中添加新规则：
```typescript
{
  id: 'route-research',
  name: 'Research Route',
  intent: 'research',
  targetModule: 'research-agent',
  description: '文献搜索和研究',
  priority: 100,
}
```

2. 更新 `systemPrompt` 添加新路由说明

3. Router 自动支持新路由

## 部署

### 自动加载

将编译后的模块放入 autostart 目录：
```bash
cp dist/agents/router/router-agent.js ~/.finger/autostart/
myfinger daemon restart
```

### 手动注册

```bash
myfinger daemon register-module -f ./dist/agents/router/router-agent.js
```

## 测试

### 测试 Chat 路由
```bash
myfinger daemon send -t router-input \
  -m '{"type":"user.input","text":"什么是 TypeScript?"}'
```

### 测试 Task 路由
```bash
myfinger daemon send -t router-input \
  -m '{"type":"user.input","text":"帮我创建一个新组件"}'
```

## 日志

```
[RouterAgent] Received user input
[RouterAgent] Intent analysis complete
  → intent: "task", confidence: 0.95, target: "task-orchestrator"
[RouterAgent] Routing to target
  → target: "task-orchestrator"
```

## 性能优化

1. **意图缓存**：相似输入可缓存结果
2. **并行分析**：多个输入可并行调用 LLM
3. **降级策略**：LLM 不可用时自动 fallback 到规则

## 监控指标

- 意图分析准确率
- 路由决策延迟
- Fallback 使用率
- 各路由流量分布
