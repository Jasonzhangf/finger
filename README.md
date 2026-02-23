# Finger - AI Agent 编排系统

基于状态机的多 Agent 协作编排系统，支持语义理解、路由决策、任务规划、执行和审查的完整工作流。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Layer                                │
│  finger understand | route | plan | execute | review | orchestrate │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Message Hub / WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      FSM Layer (状态机层)                         │
│  WorkflowFSM | TaskFSM | AgentFSM                                │
│  idle → semantic_understanding → routing_decision → ...          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ EventBus
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Layer (Agent 层)                        │
│  Understanding | Router | Planner | Executor | Reviewer          │
│  统一输出结构：{ thought, action, params, expectedOutcome, ... } │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Tools / Resources
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Resource Layer (资源层)                        │
│  ResourcePool | ToolRegistry | MessageHub                        │
└─────────────────────────────────────────────────────────────────┘
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
# 启动守护进程（包含 HTTP + WebSocket 服务）
npm run start

# 或者使用启动脚本
./scripts/start-services.sh
```

### 3. 健康检查

```bash
./scripts/health-check.sh
```

## CLI 使用

### 语义理解

```bash
# 理解用户输入意图
finger understand "搜索 deepseek 最新发布"

# 输出示例
{
  "thought": "用户需要搜索 DeepSeek 最新发布的信息...",
  "action": "INTENT_ANALYSIS",
  "params": {
    "normalizedIntent": {
      "goal": "获取 DeepSeek 最新发布信息",
      "action": "query",
      "scope": "full_task",
      "urgency": "medium"
    },
    "taskRelation": {
      "type": "same_task_no_change",
      "confidence": 0.85,
      "reasoning": "..."
    }
  },
  "confidence": 85
}
```

### 路由决策

```bash
# 基于语义分析结果做路由决策
finger route --intent '{"normalizedIntent": {...}, "taskRelation": {...}}'

# 输出示例
{
  "thought": "根据语义分析结果，建议继续执行当前任务...",
  "action": "ROUTE_DECISION",
  "params": {
    "route": "continue_execution",
    "confidence": 0.90
  }
}
```

### 任务规划

```bash
# 规划任务分解
finger plan "搜索 deepseek 最新发布并生成报告"

# 输出示例
{
  "thought": "需要搜索和文件写入两个能力...",
  "action": "TASK_PLAN",
  "params": {
    "tasks": [
      {
        "id": "task-1",
        "description": "搜索 DeepSeek 最新版本信息",
        "dependencies": [],
        "requiredCapabilities": ["web_search"]
      },
      {
        "id": "task-2",
        "description": "生成报告文件",
        "dependencies": ["task-1"],
        "requiredCapabilities": ["file_ops"]
      }
    ]
  }
}
```

### 任务执行

```bash
# 执行单个任务
finger execute --task "搜索 Node.js 最新版本" --agent executor-general

# 执行任务并等待结果
finger execute --task "创建配置文件" --blocking

# 查看执行进度
finger execute --status <task-id>
```

### 任务审查

```bash
# 审查执行方案
finger review --proposal '{"thought": "...", "action": "...", "params": {...}}'

# 输出示例
{
  "thought": "方案逻辑清晰，工具选择合适...",
  "action": "REVIEW_APPROVE",
  "params": {
    "approved": true,
    "score": 92,
    "feedback": "方案设计良好"
  }
}
```

### 编排协调

```bash
# 启动编排流程
finger orchestrate --task "搜索 deepseek 最新发布"

# 查看编排状态
finger orchestrate --status <workflow-id>

# 暂停编排
finger orchestrate --pause <workflow-id>

# 恢复编排
finger orchestrate --resume <workflow-id>
```

## 状态机

### 工作流状态

```
idle → semantic_understanding → routing_decision → plan_loop → execution → review → completed
                              ↓                        ↓           ↓
                        wait_user_decision      replan_evaluation paused
```

### 任务状态

```
created → ready → dispatching → dispatched → running → execution_succeeded → reviewing → done
                        ↓                       ↓            ↓
                  dispatch_failed        execution_failed  review_reject → rework_required
```

### Agent 状态

```
idle → reserved → running → idle
                  ↓
                error → idle (after recovery)
```

## WebSocket 订阅

### 连接 WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8081');

ws.onopen = () => {
  // 订阅状态更新
  ws.send(JSON.stringify({
    type: 'subscribe',
    groups: ['TASK', 'DIALOG', 'PROGRESS']
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log('Received:', msg);
};
```

### 事件类型

| 事件类型 | 说明 | Payload |
|---------|------|---------|
| `phase_transition` | 阶段转换 | `{ from, to, trigger }` |
| `workflow_update` | 工作流更新 | `{ workflowId, status, fsmState }` |
| `task_update` | 任务更新 | `{ taskId, status, fsmState }` |
| `agent_update` | Agent 更新 | `{ agentId, status, step }` |

## API 端点

### 工作流状态

```bash
# 获取单个工作流状态
curl http://localhost:8080/api/v1/workflows/wf-1/state

# 获取所有工作流状态
curl http://localhost:8080/api/v1/workflows/state
```

### 资源池

```bash
# 查看可用资源
curl http://localhost:8080/api/v1/resources

# 部署资源
curl -X POST http://localhost:8080/api/v1/resources/deploy \
  -H "Content-Type: application/json" \
  -d '{"resourceId": "executor-general", "sessionId": "s1", "workflowId": "wf-1"}'
```

## 配置

### 状态掩码配置

在 UI 中控制哪些状态对用户可见：

```typescript
const maskConfig = {
  workflowStates: {
    hide: ['semantic_understanding', 'routing_decision'], // 隐藏内部状态
    showAs: {},
  },
  showDetailedStates: false, // 开发模式显示所有状态
};
```

### Agent 提示词配置

每个 Agent 有独立的提示词模板，位于 `src/agents/prompts/`：

- `understanding-prompts.ts`: 语义理解 Agent
- `router-prompts.ts`: 路由决策 Agent
- `planner-prompts.ts`: 任务规划 Agent
- `executor-prompts.ts`: 任务执行 Agent
- `reviewer-prompts.ts`: 质量审查 Agent
- `orchestrator-prompts.ts`: 编排协调 Agent

## 测试

```bash
# 运行所有测试
npm test

# 运行特定测试
npm test -- workflow-fsm
npm test -- workflow-state-bridge
npm test -- useWorkflowFSM

# 覆盖率
npm run test:coverage
```

## 项目结构

```
finger/
├── src/
│   ├── agents/           # Agent 层
│   │   ├── prompts/      # 提示词模板
│   │   ├── runtime/      # 运行时
│   │   └── daemon/       # 守护进程
│   ├── orchestration/    # 编排层
│   │   ├── workflow-fsm.ts       # 工作流状态机
│   │   ├── workflow-state-bridge.ts # 状态桥接
│   │   └── resource-pool.ts      # 资源池
│   ├── runtime/          # 运行时
│   │   ├── event-bus.ts  # 事件总线
│   │   └── events.ts     # 事件定义
│   └── server/           # 服务器
│       └── index.ts      # HTTP + WebSocket
├── ui/                   # 前端 UI
│   └── src/
│       ├── hooks/        # React Hooks
│       ├── components/   # UI 组件
│       └── api/          # API 客户端
├── tests/                # 测试
│   ├── unit/             # 单元测试
│   └── integration/      # 集成测试
└── docs/                 # 文档
    └── design/           # 设计文档
```

## 开发指南

### 添加新的 Agent

1. 在 `src/agents/prompts/` 创建提示词文件
2. 在 `src/agents/daemon/` 创建 Agent 实现
3. 注册到 `src/orchestration/module-registry.ts`

### 添加新的 FSM 状态

1. 在 `src/orchestration/workflow-fsm.ts` 添加状态定义
2. 添加状态转换规则
3. 在 `ui/src/api/types.ts` 添加类型定义
4. 更新状态掩码配置

### 添加新的 CLI 命令

1. 在 `src/cli/` 创建命令文件
2. 使用 `MessageHub` 发送消息
3. 订阅 WebSocket 接收结果

## License

MIT
