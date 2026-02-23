# Finger CLI 设计文档

## 1. 架构概览

```
┌─���───────────────────────────────────────────────────────────┐
│                      CLI Layer                              │
│  finger <command> [options]                                │
│  - finger start                                            │
│  - finger stop                                             │
│  - finger status                                           │
│  - finger understand "task"                                │
│  - finger plan "task"                                      │
│  - finger execute --task "xxx"                             │
│  - finger review --proposal xxx                            │
│  - finger orchestrate "task" --watch                       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Daemon Process                            │
│  - 常驻后台进程                                             │
│  - 管理所有 Agent 实例                                      │
│  - 管理消息路由                                             │
│  - 管理 WebSocket 连接                                      │
│  - 持久化会话状态                                           │
└─────────────────────────────────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │ Orchestrator │ │   Executor   │ │   Reviewer   │
    │    Agent     │ │    Agent     │ │    Agent     │
    └──────────────┘ └──────────────┘ └──────────────┘
```

## 2. 生命周期管理

### 2.1 Daemon 进程

```bash
# 启动守护进程（后台运行）
finger daemon start

# 停止守护进程
finger daemon stop

# 重启守护进程
finger daemon restart

# 查看状态
finger daemon status

# 查看日志
finger daemon logs [-f]
```

**Daemon 职责**:
- 启动 HTTP Server (端口 8080)
- 启动 WebSocket Server (端口 8081)
- 初始化资源池
- 加载已持久化的会话
- 监听 CLI 命令

### 2.2 进程模型

```
finger daemon start
    │
    ▼
┌───────────────────────��─────────────┐
│           Main Process              │
│  - HTTP Server (8080)               │
│  - WebSocket Server (8081)          │
│  - MessageHub                       │
│  - ResourcePool                     │
│  - WorkflowManager                  │
└─────────────────────────────────────┘
         │              │
         ▼              ▼
  ┌────────────┐  ┌────────────┐
  │ Agent Proc │  │ Agent Proc │
  │ (Worker 1) │  │ (Worker 2) │
  └────────────┘  └────────────┘
```

## 3. 命令接口设计

### 3.1 交互模式

**模式 A: 一次性命令**
```bash
# 执行单次任务，完成后退出
finger execute --task "搜索 deepseek" --blocking

# 输出到 stdout，适合管道
finger plan "任务描述" --json | jq '.tasks'
```

**模式 B: 交互式会话**
```bash
# 进入交互模式
finger repl

> 理解任务: 搜索 deepseek 最新发布
[Orchestrator] 分析意图...
[Orchestrator] 意图: 信息检索
[Orchestrator] 路由: 继续执行

> 执行任务
[Executor] 派发任务: web_search
[Executor] 执行中...
[Executor] 结果: 找到 10 条结果

> 需要更多细节，请补充: xxx
[User Input] xxx
...
```

**模式 C: 监视模式**
```bash
# 持续监视工作流状态
finger orchestrate "任务" --watch

[10:00:01] Phase: semantic_understanding
[10:00:02] Phase: routing_decision → plan_loop
[10:00:05] Task 1: dispatching → running
[10:00:10] Task 1: completed
[10:00:10] All tasks completed
```

### 3.2 标准输入输出

**输入源**:
1. 命令行参数: `finger plan "任务"`
2. 管道: `echo "任务" | finger plan`
3. 文件: `finger plan --file task.txt`
4. 交互式: `finger repl`

**输出格式**:
```bash
# 人类可读 (默认)
finger status wf-123
Workflow: wf-123
Status: executing
Phase: execution
Tasks: 3/5 completed

# JSON (机器可读)
finger status wf-123 --json
{"workflowId":"wf-123","status":"executing",...}

# SSE 流 (实时)
finger orchestrate "task" --stream
event: phase_transition
data: {"from":"plan_loop","to":"execution"}

event: task_started
data: {"taskId":"task-1","agent":"executor-1"}
```

### 3.3 等待用户输入

当 Agent 需要用户决策时：

```bash
finger orchestrate "搜索 deepseek 并生成报告"

[Orchestrator] 分析任务...
[Orchestrator] 检测到资源缺失: web_search 需要网络访问

❓ 是否继续执行？(Y/n) 
> Y

[Orchestrator] 继续执行...
[Executor] 任务执行中...

❓ 找到 10 篇论文，下载哪些？
  1. paper1.pdf
  2. paper2.pdf
  3. paper3.pdf
> 1,3

[Executor] 下载 paper1.pdf, paper3.pdf...
```

## 4. 程序化调用

### 4.1 内部模块调用

```typescript
// 其他模块调用 CLI 命令
import { executeCLICommand } from './cli/executor.js';

// 同步调用
const result = await executeCLICommand('plan', {
  task: '搜索 deepseek',
  sessionId: 'session-123',
});

// 流式调用
const stream = await executeCLICommand('orchestrate', {
  task: '搜索 deepseek',
  watch: true,
});

for await (const event of stream) {
  console.log(event);
}
```

### 4.2 外部进程调用

```typescript
// 通过 HTTP API 调用
const response = await fetch('http://localhost:8080/api/v1/agent/plan', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    task: '搜索 deepseek',
    sessionId: 'session-123',
  }),
});

// 通过 WebSocket 订阅
const ws = new WebSocket('ws://localhost:8081');
ws.send(JSON.stringify({
  type: 'subscribe',
  events: ['phase_transition', 'task_started', 'task_completed'],
}));

ws.onmessage = (msg) => {
  const event = JSON.parse(msg.data);
  console.log(event);
});
```

### 4.3 子进程调用

```typescript
// 启动子进程执行命令
import { spawn } from 'child_process';

const child = spawn('finger', ['execute', '--task', 'xxx', '--blocking']);

child.stdout.on('data', (data) => {
  console.log(`stdout: ${data}`);
});

child.stderr.on('data', (data) => {
  console.error(`stderr: ${data}`);
});

child.on('close', (code) => {
  console.log(`子进程退出码: ${code}`);
});
```

## 5. 状态机与 CLI 交互

### 5.1 状态映射

```
┌─────────────────────────────────────────────────────────┐
│                    Workflow FSM                         │
│                                                         │
│  idle                                                   │
│    │ user_input_received                                │
│    ▼                                                    │
│  semantic_understanding  ──intent_analyzed──► routing   │
│                                                         │
│  routing_decision                                       │
│    │ routing_decided                                    │
│    ├───────────────────► plan_loop (full_replan)       │
│    ├───────────────────► execution (continue)          │
│    └───────────────────► wait_user_decision            │
│                                                         │
│  plan_loop ──plan_created──► execution                 │
│                                                         │
│  execution ──task_completed──► review                  │
│           ──major_change──► replan_evaluation          │
│                                                         │
│  review ──review_passed──► execution/completed         │
│        ──review_rejected──► plan_loop                  │
│                                                         │
│  wait_user_decision ──user_decision──► routing         │
│                                                         │
│  paused ──resume──► * (previous)                       │
└─────────────────────────────────────────────────────────┘
```

### 5.2 CLI 触发状态转换

```bash
# 发送用户输入，触发 user_input_received
finger input "继续执行"

# 暂停工作流
finger pause wf-123
# 触发 pause_requested → paused

# 恢复工作流
finger resume wf-123
# 触发 resume_requested → previous_state

# 取消工作流
finger cancel wf-123
# 触发 cancel_requested → failed
```

## 6. 事件订阅

### 6.1 CLI 订阅事件

```bash
# 订阅特定工作流的所有事件
finger events wf-123 --follow

# 订阅特定类型事件
finger events wf-123 --types phase_transition,task_started

# 订阅特定分组事件
finger events --group TASK,PROGRESS
```

### 6.2 事件格式

```json
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
```

## 7. 会话管理

### 7.1 会话持久化

```
~/.finger/
├── daemon.pid           # Daemon PID
├── daemon.log           # Daemon 日志
├── sessions/
│   ├── session-123/
│   │   ├── checkpoint.json
│   │   ├── tasks.json
│   │   └── events.jsonl
│   └── session-456/
│       └── ...
└── workflows/
    └── wf-789.json
```

### 7.2 会话恢复

```bash
# 列出可恢复会话
finger sessions --resumable

# 恢复会话
finger resume-session session-123

# 或在 UI 中提示
finger ui
# 自动检测到未完成会话，弹出恢复对话框
```

## 8. 错误处理

### 8.1 错误码

```bash
# CLI 退出码
0   成功
1   通用错误
2   参数错误
3   连接错误 (Daemon 未启动)
4   资源缺失
5   任务失败
6   用户取消
```

### 8.2 错误输出

```bash
finger execute --task "xxx"
# 错误输出到 stderr
Error: Resource missing: web_search capability not available
Code: 4

# JSON 格式
finger execute --task "xxx" --json 2>&1
{"error": "Resource missing", "code": 4, "details": {...}}
```

## 9. 配置

### 9.1 配置文件

```bash
# ~/.finger/config.yaml
daemon:
  httpPort: 8080
  wsPort: 8081
  logLevel: info

agent:
  provider: iflow
  timeout: 300000

resource:
  maxConcurrent: 5
  timeout: 60000
```

### 9.2 环境变量

```bash
FINGER_HTTP_PORT=8080
FINGER_WS_PORT=8081
FINGER_LOG_LEVEL=debug
IFLOW_API_KEY=xxx
```

## 10. 示例工作流

### 10.1 完整任务执行

```bash
# 1. 启动 daemon
finger daemon start

# 2. 执行任务 (交互式)
finger orchestrate "搜索 deepseek 最新发布，生成报告"

# CLI 输出:
[10:00:00] Starting workflow: wf-123
[10:00:00] Phase: semantic_understanding
[10:00:01] Phase: routing_decision
[10:00:02] Phase: plan_loop
[10:00:02] Plan created with 3 tasks:
           1. web_search: 搜索 deepseek
           2. read_papers: 下载论文
           3. write_report: 生成报告

❓ 检测到网络访问，是否继续？(Y/n)
> Y

[10:00:05] Phase: execution
[10:00:05] Task 1: dispatching → running
[10:00:10] Task 1: completed ✓
[10:00:10] Task 2: dispatching → running

❓ 找到 5 篇论文，选择哪些��
  1. paper1.pdf
  2. paper2.pdf
  3. paper3.pdf
  4. paper4.pdf
  5. paper5.pdf
> 1,2,3

[10:00:20] Task 2: completed ✓
[10:00:20] Task 3: running
[10:00:30] Task 3: completed ✓
[10:00:30] Phase: review
[10:00:31] Review passed ✓
[10:00:31] Phase: completed
[10:00:31] Workflow completed: wf-123

# 3. 查看结果
finger output wf-123
Report saved to: ./deepseek/report.md

# 4. 停止 daemon (可选)
finger daemon stop
```

### 10.2 程序化执行

```typescript
import { FingerClient } from 'finger-sdk';

const client = new FingerClient({
  httpUrl: 'http://localhost:8080',
  wsUrl: 'ws://localhost:8081',
});

// 订阅事件
client.subscribe(['phase_transition', 'task_*'], (event) => {
  console.log(`[${event.type}]`, event.payload);
});

// 执行任务
const workflow = await client.orchestrate('搜索 deepseek 最新发布', {
  watch: true,
});

// 等待用户决策
workflow.on('user_decision_required', async (prompt) => {
  const answer = await getUserInput(prompt.message);
  await workflow.respond(answer);
});

// 等待完成
const result = await workflow.wait();
console.log('Result:', result);
```

---

**设计原则**:
1. CLI 是异步的，启动后常驻后台
2. 所有命令通过标准输入输出通信
3. 支持交互式和程序化两种模式
4. 需要用户输入时阻塞并提示
5. 状态通过事件流实时同步
6. 会话可持久化和恢复
