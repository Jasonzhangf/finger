# CLI 实现计划

## 1. 当前架构分析

### 1.1 现有组件

| 组件 | 位置 | 状态 |
|------|------|------|
| CLI 入口 | `src/cli/index.ts` | ✅ 基础命令已实现 |
| Agent Commands | `src/cli/agent-commands.ts` | ✅ 6个Agent命令 |
| Daemon 管理 | `src/cli/daemon.ts` | ✅ start/stop/status |
| Agent Pool | `src/orchestration/agent-pool.ts` | ✅ 进程池管理 |
| Lifecycle Manager | `src/agents/core/agent-lifecycle.ts` | ✅ 生命周期管理 |
| Heartbeat Broker | `src/agents/core/heartbeat-broker.ts` | ✅ 心跳监控 |
| Event Bus | `src/runtime/event-bus.ts` | ✅ 事件系统 |
| WebSocket Server | `src/server/index.ts` | ✅ 实时通信 |

### 1.2 需要补充

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 交互式 REPL | 支持用户输入和实时反馈 | P0 |
| 流式输出 | SSE/WebSocket 事件流 | P0 |
| 用户决策提示 | 阻塞等待用户输入 | P0 |
| 会话恢复 | 检测未完成会话并提示 | P1 |
| 标准化错误码 | 统一退出码和错误格式 | P1 |

## 2. 实现步骤

### 2.1 REPL 模式 (P0)

```typescript
// src/cli/repl.ts
import * as readline from 'readline';
import { FingerClient } from './client.js';

export class FingerREPL {
  private rl: readline.Interface;
  private client: FingerClient;
  private currentWorkflow: string | null = null;
  
  async start() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });
    
    // 连接到 daemon
    await this.client.connect();
    
    // 订阅事件
    this.client.subscribe(['*'], (event) => {
      this.printEvent(event);
    });
    
    // 处理用户输入
    this.rl.on('line', async (line) => {
      await this.handleInput(line.trim());
    });
  }
  
  private async handleInput(line: string) {
    // 解析命令或发送到 Agent
    if (line.startsWith('/')) {
      await this.handleCommand(line);
    } else {
      await this.sendTask(line);
    }
  }
  
  private async sendTask(task: string) {
    if (!this.currentWorkflow) {
      const result = await this.client.orchestrate(task, { blocking: false });
      this.currentWorkflow = result.workflowId;
    } else {
      await this.client.sendInput(this.currentWorkflow, task);
    }
  }
  
  printEvent(event: any) {
    // 根据事件类型格式化输出
    const timestamp = new Date(event.timestamp).toLocaleTimeString();
    const prefix = `[${timestamp}]`;
    
    switch (event.type) {
      case 'phase_transition':
        console.log(`${prefix} Phase: ${event.payload.from} → ${event.payload.to}`);
        break;
      case 'task_started':
        console.log(`${prefix} Task ${event.payload.taskId}: started`);
        break;
      case 'user_decision_required':
        this.promptUserDecision(event.payload);
        break;
      default:
        console.log(`${prefix} ${event.type}:`, event.payload);
    }
  }
  
  async promptUserDecision(payload: any) {
    return new Promise<void>((resolve) => {
      console.log(`\n❓ ${payload.message}`);
      if (payload.options) {
        payload.options.forEach((opt: string, i: number) => {
          console.log(`  ${i + 1}. ${opt}`);
        });
      }
      
      this.rl.question('> ', async (answer) => {
        await this.client.respondDecision(payload.decisionId, answer);
        resolve();
      });
    });
  }
}
```

### 2.2 FingerClient SDK (P0)

```typescript
// src/cli/client.ts
import WebSocket from 'ws';

export interface FingerClientOptions {
  httpUrl?: string;
  wsUrl?: string;
}

export class FingerClient {
  private httpUrl: string;
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private subscribers: Map<string, Set<(event: any) => void>> = new Map();
  
  constructor(options: FingerClientOptions = {}) {
    this.httpUrl = options.httpUrl || 'http://localhost:8080';
    this.wsUrl = options.wsUrl || 'ws://localhost:8081';
  }
  
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.on('open', () => {
        resolve();
      });
      
      this.ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        this.dispatch(event);
      });
      
      this.ws.on('error', reject);
    });
  }
  
  subscribe(types: string[], handler: (event: any) => void): void {
    types.forEach(type => {
      if (!this.subscribers.has(type)) {
        this.subscribers.set(type, new Set());
      }
      this.subscribers.get(type)!.add(handler);
    });
  }
  
  private dispatch(event: any): void {
    // 分发给订阅者
    const handlers = this.subscribers.get(event.type) || new Set();
    handlers.forEach(h => h(event));
    
    // 通配符订阅
    const wildcardHandlers = this.subscribers.get('*') || new Set();
    wildcardHandlers.forEach(h => h(event));
  }
  
  async orchestrate(task: string, options: { blocking?: boolean } = {}): Promise<any> {
    const res = await fetch(`${this.httpUrl}/api/v1/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'orchestrator-loop',
        message: { content: task },
        blocking: options.blocking ?? false,
      }),
    });
    return res.json();
  }
  
  async sendInput(workflowId: string, input: string): Promise<void> {
    await fetch(`${this.httpUrl}/api/v1/workflow/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, input }),
    });
  }
  
  async respondDecision(decisionId: string, response: string): Promise<void> {
    await fetch(`${this.httpUrl}/api/v1/decision/${decisionId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response }),
    });
  }
  
  async pause(workflowId: string): Promise<void> {
    await fetch(`${this.httpUrl}/api/v1/workflow/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId }),
    });
  }
  
  async resume(workflowId: string): Promise<void> {
    await fetch(`${this.httpUrl}/api/v1/workflow/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId }),
    });
  }
  
  async getStatus(workflowId: string): Promise<any> {
    const res = await fetch(`${this.httpUrl}/api/v1/workflows/${workflowId}/state`);
    return res.json();
  }
  
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
```

### 2.3 用户决策 API (P0)

```typescript
// src/server/index.ts 添加

// 存储待决策
const pendingDecisions = new Map<string, {
  workflowId: string;
  message: string;
  options?: string[];
  resolve: (response: string) => void;
}>();

// 创建决策请求
app.post('/api/v1/decision', (req, res) => {
  const { workflowId, message, options } = req.body;
  const decisionId = `decision-${Date.now()}`;
  
  pendingDecisions.set(decisionId, {
    workflowId,
    message,
    options,
    resolve: () => {}, // 将在等待时设置
  });
  
  // 广播给所有客户端
  const broadcastMsg = JSON.stringify({
    type: 'user_decision_required',
    payload: { decisionId, workflowId, message, options },
    timestamp: new Date().toISOString(),
  });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }
  
  res.json({ decisionId });
});

// 响应决策
app.post('/api/v1/decision/:decisionId/respond', async (req, res) => {
  const { decisionId } = req.params;
  const { response } = req.body;
  
  const decision = pendingDecisions.get(decisionId);
  if (!decision) {
    res.status(404).json({ error: 'Decision not found' });
    return;
  }
  
  // 通知等待者
  if (decision.resolve) {
    decision.resolve(response);
  }
  
  pendingDecisions.delete(decisionId);
  
  res.json({ success: true });
});

// 等待决策（内部 API）
export async function waitForUserDecision(
  workflowId: string,
  message: string,
  options?: string[]
): Promise<string> {
  return new Promise((resolve) => {
    const decisionId = `decision-${Date.now()}`;
    
    pendingDecisions.set(decisionId, {
      workflowId,
      message,
      options,
      resolve,
    });
    
    // 广播
    const broadcastMsg = JSON.stringify({
      type: 'user_decision_required',
      payload: { decisionId, workflowId, message, options },
      timestamp: new Date().toISOString(),
    });
    for (const client of wsClients) {
      if (client.readyState === 1) client.send(broadcastMsg);
    }
  });
}
```

### 2.4 流式输出 (P0)

```bash
# 添加 --stream 参数支持 SSE
finger orchestrate "task" --stream

# 输出格式 (SSE)
event: phase_transition
data: {"from":"idle","to":"semantic_understanding"}

event: task_started
data: {"taskId":"task-1","agent":"executor-1"}

event: done
data: {"workflowId":"wf-123","status":"completed"}
```

```typescript
// src/cli/stream.ts
export async function streamWorkflow(task: string): Promise<void> {
  const res = await fetch('http://localhost:8080/api/v1/workflow/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
  });
  
  const reader = res.body?.getReader();
  if (!reader) return;
  
  const decoder = new TextDecoder();
  let buffer = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        const eventType = line.slice(7);
        // 下一行是 data
      } else if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        printEvent(eventType, data);
      }
    }
  }
}
```

### 2.5 会话恢复 (P1)

```bash
# CLI 检测未完成会话
finger start

检测到未完成的会话:
  1. session-123: "搜索 deepseek" (进度: 60%)
  2. session-456: "生成报告" (进度: 30%)

恢复哪个会话？(1/2/n)
> 1

[session-123] 恢复中...
[session-123] 当前阶段: execution
[session-123] 继续执行...
```

```typescript
// src/cli/session-resume.ts
export async function checkResumableSessions(): Promise<SessionInfo[]> {
  const res = await fetch('http://localhost:8080/api/v1/sessions/resumable');
  const { sessions } = await res.json();
  return sessions;
}

export async function promptSessionResume(): Promise<string | null> {
  const sessions = await checkResumableSessions();
  
  if (sessions.length === 0) {
    return null;
  }
  
  console.log('检测到未完成的会话:');
  sessions.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.id}: "${s.task}" (进度: ${s.progress}%)`);
  });
  
  const answer = await prompt('恢复哪个会话？(1/2/.../n) ');
  
  if (answer === 'n' || !answer) {
    return null;
  }
  
  const index = parseInt(answer) - 1;
  if (index >= 0 && index < sessions.length) {
    return sessions[index].id;
  }
  
  return null;
}
```

## 3. 错误码标准

```typescript
// src/cli/errors.ts
export enum ExitCode {
  SUCCESS = 0,
  GENERAL_ERROR = 1,
  INVALID_ARGS = 2,
  CONNECTION_ERROR = 3,
  RESOURCE_MISSING = 4,
  TASK_FAILED = 5,
  USER_CANCELLED = 6,
  TIMEOUT = 7,
  PERMISSION_DENIED = 8,
}

export class FingerError extends Error {
  constructor(
    message: string,
    public code: ExitCode,
    public details?: any
  ) {
    super(message);
    this.name = 'FingerError';
  }
}

// 全局错误处理
process.on('uncaughtException', (err) => {
  if (err instanceof FingerError) {
    console.error(`Error: ${err.message}`);
    console.error(`Code: ${err.code}`);
    process.exit(err.code);
  } else {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
});
```

## 4. 文件结构

```
src/cli/
├── index.ts              # CLI 入口
├── agent-commands.ts     # Agent 命令
├── daemon.ts             # Daemon 管理
├── repl.ts               # REPL 模式 (新增)
├── client.ts             # FingerClient SDK (新增)
├── stream.ts             # 流式输出 (新增)
├── session-resume.ts     # 会话恢复 (新增)
├── errors.ts             # 错误码定义 (新增)
└── output.ts             # 输出格式化 (新增)
```

## 5. 测试计划

### 5.1 单元测试

- [ ] FingerClient 连接/订阅/发送
- [ ] REPL 命令解析
- [ ] 错误码处理
- [ ] 会话恢复检测

### 5.2 集成测试

- [ ] 完整任务执行流程
- [ ] 用户决策中断/继续
- [ ] 多轮对话
- [ ] 错误恢复

### 5.3 E2E 测试

```bash
# 测试完整流程
finger daemon start
finger orchestrate "测试任务" --stream
# 等待用户决策
# 输入决策
# 验证完成
finger daemon stop
```

---

**实现顺序**:
1. FingerClient SDK (依赖其他模块)
2. 用户决策 API (后端)
3. REPL 模式 (前端)
4. 流式输出
5. 会话恢复
6. 错误码标准化
