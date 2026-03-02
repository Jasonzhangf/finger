# CLI 调用流程设计

## 1. 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户交互层                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  CLI (终端)  │  │  Web UI      │  │  外部程序    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    FingerClient SDK                          │
│  - HTTP API 调用                                             │
│  - WebSocket 事件订阅                                        │
│  - 用户决策响应                                              │
│  - 状态同步                                                  │
└─────────────────────────────────────────────────────────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    Daemon Process                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ HTTP Server  │  │ WS Server    │  │ MessageHub   │      │
│  │  :8080       │  │ :8081        │  │              │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ WorkflowFSM  │  │ ResourcePool │  │ EventBus     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                      Agent Layer                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Orchestrator │  │  Executor    │  │  Reviewer    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## 2. 调用链路

### 2.1 启动任务

```
CLI: finger orchestrate "搜索 deepseek"
  │
  ├─> FingerClient.orchestrate(task)
  │     │
  │     └─> POST /api/v1/message
  │           {
  │             "target": "finger-orchestrator",
  │             "message": { "content": "搜索 deepseek" },
  │             "blocking": false
  │           }
  │
  └─> Daemon 接收并处理
        │
        ├─> MessageHub.sendToModule('finger-orchestrator', message)
        │
        ├─> WorkflowFSM.trigger('user_input_received')
        │     idle → semantic_understanding
        │
        ├─> EventBus.emit('phase_transition')
        │
        └─> WebSocket 广播事件
              {
                "type": "phase_transition",
                "payload": { "from": "idle", "to": "semantic_understanding" }
              }
```

### 2.2 用户决策

```
Agent 执行遇到需要用户决策的情况
  │
  ├─> 调用 waitForUserDecision(message, options)
  │
  ├─> Daemon 广播 user_decision_required
  │     {
  │       "type": "user_decision_required",
  │       "payload": {
  │         "decisionId": "decision-xxx",
  │         "message": "是否继续执行？",
  │         "options": ["Y", "n"]
  │       }
  │     }
  │
  ├─> CLI/WebUI 显示提示
  │
  ├─> 用户输入 "Y"
  │
  ├─> FingerClient.respondDecision(decisionId, "Y")
  │     POST /api/v1/decision/{decisionId}/respond
  │
  └─> Agent 继续执行
```

### 2.3 状态订阅

```
CLI: finger orchestrate "task" --watch
  │
  ├─> FingerClient.connect()
  │     WebSocket 连接到 ws://localhost:8081
  │
  ├─> FingerClient.subscribe(['*'], handler)
  │     发送: { "type": "subscribe", "events": ["*"] }
  │
  └─> 接收事件流
        event: phase_transition
        data: {"from":"idle","to":"semantic_understanding"}

        event: task_started
        data: {"taskId":"task-1"}

        event: agent_update
        data: {"agentId":"executor-1","status":"running"}
```

## 3. API 端点

### 3.1 Workflow API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/message` | POST | 发送消息到 Agent |
| `/api/v1/workflow/input` | POST | 发送用户输入 |
| `/api/v1/workflow/pause` | POST | 暂停工作流 |
| `/api/v1/workflow/resume` | POST | 恢复工作流 |
| `/api/v1/workflow/:id/transition` | POST | 触发状态转换 |
| `/api/v1/workflows` | GET | 列出所有工作流 |
| `/api/v1/workflows/:id/state` | GET | 获取工作流状态 |
| `/api/v1/workflows/:id/tasks` | GET | 获取任务列表 |

### 3.2 Decision API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/decision` | POST | 创建决策请求 |
| `/api/v1/decision/:id/respond` | POST | 响应决策 |

### 3.3 Session API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/sessions/resumable` | GET | 列出可恢复会话 |
| `/api/v1/sessions/:id/resume` | POST | 恢复会话 |
| `/api/v1/sessions/:id/checkpoint/latest` | GET | 获取最新检查点 |

### 3.4 Agent API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/agents` | GET | 列出所有 Agent |
| `/api/v1/agents/:id/capabilities` | GET | 获取 Agent 能力 |

### 3.5 Event API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/events/types` | GET | 获取事件类型列表 |
| `/api/v1/events/groups` | GET | 获取事件分组列表 |
| `/api/v1/events/history` | GET | 获取历史事件 |

## 4. WebSocket 消息格式

### 4.1 客户端 → 服务器

```typescript
// 订阅事件
{
  "type": "subscribe",
  "events": ["phase_transition", "task_started"],
  "groups": ["TASK", "PROGRESS"]
}

// 取消订阅
{
  "type": "unsubscribe",
  "events": ["phase_transition"]
}
```

### 4.2 服务器 → 客户端

```typescript
// 阶段转换
{
  "type": "phase_transition",
  "sessionId": "session-123",
  "timestamp": "2026-02-23T03:00:00.000Z",
  "payload": {
    "from": "plan_loop",
    "to": "execution",
    "trigger": "plan_created"
  }
}

// 任务状态更新
{
  "type": "task_started",
  "sessionId": "session-123",
  "timestamp": "2026-02-23T03:00:00.000Z",
  "payload": {
    "taskId": "task-1",
    "agentId": "executor-1",
    "description": "搜索 deepseek"
  }
}

// Agent 状态更新
{
  "type": "agent_update",
  "sessionId": "session-123",
  "timestamp": "2026-02-23T03:00:00.000Z",
  "payload": {
    "agentId": "executor-1",
    "status": "running",
    "load": 50,
    "currentTaskId": "task-1",
    "step": {
      "thought": "分析任务...",
      "action": "web_search",
      "observation": "找到 10 条结果"
    }
  }
}

// 用户决策请求
{
  "type": "user_decision_required",
  "sessionId": "session-123",
  "timestamp": "2026-02-23T03:00:00.000Z",
  "payload": {
    "decisionId": "decision-xxx",
    "workflowId": "wf-123",
    "message": "检测到网络访问，是否继续？",
    "options": ["Y", "n"]
  }
}

// 工作流更新
{
  "type": "workflow_update",
  "sessionId": "session-123",
  "timestamp": "2026-02-23T03:00:00.000Z",
  "payload": {
    "workflowId": "wf-123",
    "status": "executing",
    "taskUpdates": [...],
    "agentUpdates": [...],
    "orchestratorState": {
      "round": 1,
      "thought": "..."
    }
  }
}
```

## 5. 状态机与 API 映射

| 状态转换 | 触发器 | API 调用 |
|----------|--------|----------|
| idle → semantic_understanding | user_input_received | POST /api/v1/message |
| semantic_understanding → routing_decision | intent_analyzed | 内部 |
| routing_decision → plan_loop | routing_decided | POST /api/v1/workflow/:id/transition |
| plan_loop → execution | plan_created | POST /api/v1/workflow/:id/transition |
| execution → review | task_completed | POST /api/v1/workflow/:id/transition |
| review → execution | review_rejected | POST /api/v1/workflow/:id/transition |
| review → completed | review_passed | POST /api/v1/workflow/:id/transition |
| * → paused | pause_requested | POST /api/v1/workflow/pause |
| paused → * | resume_requested | POST /api/v1/workflow/resume |

## 6. 错误处理

### 6.1 HTTP 错误码

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 404 | 资源不存在 |
| 409 | 状态冲突（如暂停已暂停的工作流） |
| 500 | 服务器内部错误 |

### 6.2 错误响应格式

```json
{
  "error": "错误描述",
  "code": "ERROR_CODE",
  "details": {
    "field": "额外信息"
  }
}
```

### 6.3 CLI 退出码

| 退出码 | 说明 |
|--------|------|
| 0 | 成功 |
| 1 | 通用错误 |
| 2 | 参数错误 |
| 3 | 连接错误（Daemon 未启动） |
| 4 | 资源缺失 |
| 5 | 任务失败 |
| 6 | 用户取消 |
| 7 | 超时 |

## 7. 示例：完整流程

```bash
# 1. 启动 Daemon
finger daemon start

# 2. 启动任务
finger orchestrate "搜索 deepseek 最新发布" --watch

# 输出:
[10:00:00] Connecting to daemon...
[10:00:00] Connected
[10:00:00] Starting workflow...
[10:00:00] Phase: idle → semantic_understanding
[10:00:01] Phase: semantic_understanding → routing_decision
[10:00:02] Phase: routing_decision → plan_loop
[10:00:02] Plan created: 3 tasks
[10:00:02] Phase: plan_loop → execution
[10:00:02] Task 1: dispatching → running

❓ 检测到网络访问，是否继续？(Y/n)
> Y

[10:00:05] Decision: Y
[10:00:05] Task 1: running → completed
[10:00:05] Task 2: dispatching → running

❓ 找到 5 篇论文，选择哪些？
  1. paper1.pdf
  2. paper2.pdf
  3. paper3.pdf
> 1,3

[10:00:20] Decision: 1,3
[10:00:20] Task 2: running → completed
[10:00:20] Task 3: dispatching → running
[10:00:30] Task 3: running → completed
[10:00:30] Phase: execution → review
[10:00:31] Review: passed
[10:00:31] Phase: review → completed
[10:00:31] Workflow completed: wf-123
[10:00:31] Output saved to: ./deepseek/report.md

# 3. 查看结果
finger output wf-123
Report saved to: ./deepseek/report.md

# 4. 停止 Daemon (可选)
finger daemon stop
```

## 8. 程序化调用示例

```typescript
import { FingerClient } from 'finger';

async function main() {
  const client = new FingerClient();
  
  // 连接
  await client.connect();
  
  // 订阅事件
  client.subscribe(['phase_transition', 'task_*'], (event) => {
    console.log(`[${event.type}]`, event.payload);
  });
  
  // 设置决策处理器
  client.onDecision(async (decision) => {
    console.log(`\n❓ ${decision.message}`);
    if (decision.options) {
      decision.options.forEach((opt, i) => {
        console.log(`  ${i + 1}. ${opt}`);
      });
    }
    
    // 获取用户输入
    const answer = await getUserInput('> ');
    return answer;
  });
  
  // 执行任务
  const { workflowId } = await client.orchestrate('搜索 deepseek 最新发布');
  
  // 等待完成
  // (事件会通过订阅处理器输出)
  
  // 断开连接
  client.disconnect();
}

main().catch(console.error);
```

---

**设计原则**:
1. CLI 异步启动，后台常驻
2. 所有通信通过标准 API
3. 实时状态通过 WebSocket 推送
4. 用户决策阻塞等待
5. 状态机驱动流程
