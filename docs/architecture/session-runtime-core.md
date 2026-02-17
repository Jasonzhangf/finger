# Finger 会话与进度管理模块 - 设计文档

## 1. 架构决策

| 决策点 | 选择 | 说明 |
|--------|------|------|
| 抽象边界 | 混合直接 SDK | 高级子 Agent 可直接调用 iflow SDK；基础能力由 Runtime Core 提供 |
| 进度模型 | 统一事件流 | session/task/tool/dialog/progress 统一事件模型，服务端推送 |
| 工具控制 | 最小策略 | 仅 allow/deny，后续扩展 confirm/timeout/retry |

## 2. 核心架构

### 2.1 三层结构

```
┌─────────────────────────────────────────────────────────────────┐
│                      Runtime Core (新增)                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                  UnifiedEventBus                             ││
│  │   SessionEvent | TaskEvent | ToolEvent | DialogEvent         ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────────┐  │
│  │SessionManager│ │ ToolRegistry │ │  ProgressAggregator      │  │
│  │ (已有增强)   │ │  (最小策略)   │ │  (统一进度聚合)          │  │
│  └─────────────┘ └──────────────┘ └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
           ▲                        ▲
           │                        │
           │ Facade API             │ Direct SDK
           │                        │
┌──────────┴─────────┐    ┌─────────┴──────────┐
│   子 Agent (基础)   │    │   子 Agent (高级)   │
│  通过 Facade 调用   │    │  可直接调用 SDK     │
│  Executor/Reviewer │    │  Orchestrator/自定义│
└────────────────────┘    └────────────────────┘
```

### 2.2 统一事件模型 (`src/runtime/events.ts`)

```typescript
// 统一事件类型
type RuntimeEvent =
  | SessionEvent
  | TaskEvent
  | ToolEvent
  | DialogEvent
  | ProgressEvent;

interface SessionEvent {
  type: 'session_created' | 'session_resumed' | 'session_paused' | 'session_compressed';
  sessionId: string;
  timestamp: string;
  payload: {
    name?: string;
    messageCount?: number;
    compressedSize?: number;
  };
}

interface TaskEvent {
  type: 'task_started' | 'task_progress' | 'task_completed' | 'task_failed';
  taskId: string;
  sessionId: string;
  agentId?: string;
  timestamp: string;
  payload: {
    title?: string;
    progress?: number;      // 0-100
    result?: unknown;
    error?: string;
  };
}

interface ToolEvent {
  type: 'tool_call' | 'tool_result' | 'tool_error';
  toolId: string;
  toolName: string;
  agentId: string;
  timestamp: string;
  payload: {
    input?: unknown;
    output?: unknown;
    error?: string;
    duration?: number;
  };
}

interface DialogEvent {
  type: 'user_message' | 'assistant_chunk' | 'assistant_complete';
  sessionId: string;
  timestamp: string;
  payload: {
    messageId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    attachments?: Attachment[];
  };
}

interface ProgressEvent {
  type: 'plan_updated' | 'workflow_progress';
  sessionId: string;
  timestamp: string;
  payload: {
    plan?: Plan;
    overallProgress: number;
    activeAgents: string[];
    pendingTasks: number;
    completedTasks: number;
  };
}
```

### 2.3 统一事件总线 (`src/runtime/event-bus.ts`)

```typescript
class UnifiedEventBus {
  private handlers = new Map<string, Set<(event: RuntimeEvent) => void>>();
  private wsClients = new Set<WebSocket>();

  subscribe(eventType: string, handler: (event: RuntimeEvent) => void): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    return () => this.handlers.get(eventType)?.delete(handler);
  }

  emit(event: RuntimeEvent): void {
    // 1. 触发本地订阅者
    const handlers = this.handlers.get(event.type);
    handlers?.forEach(h => h(event));

    // 2. 广播到 WebSocket 客户端
    const msg = JSON.stringify(event);
    this.wsClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
  }

  // 从 iflow SDK 消息转换为统一事件
  fromIflowMessage(msg: IflowMessage): RuntimeEvent | null {
    // 映射逻辑见 iflow-runtime-adapter.ts
  }
}
```

### 2.4 Runtime Facade (`src/runtime/runtime-facade.ts`)

统一运行时门面 - 提供给基础子 Agent 使用。高级 Agent 可直接调用 iflow SDK，但仍可使用事件发布。

主要方法:
- `createSession(projectPath, name?)` - 创建会话
- `compressContext(sessionId)` - 压缩上下文
- `sendMessage(sessionId, content, attachments?)` - 发送消息
- `callTool(agentId, toolName, input)` - 调用工具 (最小策略: allow/deny)
- `reportProgress(sessionId, progress)` - 报告进度

### 2.5 工具注册表 (最小策略) (`src/runtime/tool-registry.ts`)

```typescript
type ToolPolicy = 'allow' | 'deny';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  policy: ToolPolicy;
  handler: (input: unknown) => Promise<unknown>;
}

class ToolRegistry {
  register(tool: ToolDefinition): void;
  getPolicy(toolName: string): ToolPolicy;
  setPolicy(toolName: string, policy: ToolPolicy): void;
  async execute(toolName: string, input: unknown): Promise<unknown>;
  list(): ToolDefinition[];
}
```

### 2.6 iflow Runtime Adapter (`src/agents/sdk/iflow-runtime-adapter.ts`)

将 iflow SDK 消息转换为统一事件，高级 Agent 可直接使用 SDK，通过适配器发布事件。

```typescript
class IflowRuntimeAdapter {
  constructor(private client: IFlowClient, private eventBus: UnifiedEventBus) {}

  async *receiveMessagesWithEvents(): AsyncGenerator<IflowMessage> {
    for await (const msg of this.client.receiveMessages()) {
      const event = this.convertToEvent(msg);
      if (event) this.eventBus.emit(event);
      yield msg;
    }
  }
}
```

## 3. Session Core 模块

### 3.1 Session Manager 增强

已有 `src/orchestration/session-manager.ts`，需要增强:

- 上下文压缩 (摘要式)
- Plan 管理
- 命令框架 (/command)

### 3.2 上下文压缩 (`src/session/core/context-compressor.ts`)

摘要式压缩策略:

```typescript
class ContextCompressor {
  private readonly COMPRESS_THRESHOLD = 50;
  private readonly TOKEN_THRESHOLD = 8000;

  async compress(session: Session): Promise<string> {
    // 1. 提取早期消息 (前 N 条)
    const earlyMessages = session.messages.slice(0, -this.COMPRESS_THRESHOLD);

    // 2. 使用 LLM 生成摘要
    const summary = await this.generateSummary(earlyMessages);

    // 3. 保留近期消息完整
    const recentMessages = session.messages.slice(-this.COMPRESS_THRESHOLD);

    return `[历史摘要] ${summary}\n\n[近期对话] ${this.formatMessages(recentMessages)}`;
  }
}
```

### 3.3 Plan 管理 (`src/session/core/plan-manager.ts`)

```typescript
interface Plan {
  id: string;
  version: number;
  originalTask: string;
  tasks: Task[];
  dependencies: Map<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

class PlanManager {
  createPlan(sessionId: string, tasks: Task[]): Plan;
  updateTaskStatus(planId: string, taskId: string, status: TaskStatus): void;
  getExecutionOrder(planId: string): Task[];  // 拓扑排序
  getCriticalPath(planId: string): Task[];    // 关键路径
  buildProgressReport(planId: string): ProgressReport;
}
```

### 3.4 命令框架 (`src/session/core/command-registry.ts`)

注册式架构:

```typescript
interface CommandHandler {
  name: string;
  description: string;
  args: CommandArg[];
  execute: (session: Session, args: Record<string, unknown>) => Promise<CommandResult>;
}

class CommandRegistry {
  register(handler: CommandHandler): void;
  async execute(session: Session, commandLine: string): Promise<CommandResult>;
}
```

内置命令:
| 命令 | 功能 | 示例 |
|------|------|------|
| `/plan` | Plan 管理 | `/plan show`, `/plan update <json>` |
| `/task` | 任务操作 | `/task list`, `/task status <id>`, `/task pause` |
| `/session` | 会话管理 | `/session rename <name>`, `/session export` |
| `/context` | 上下文管理 | `/context compress`, `/context clear` |
| `/file` | 文件引用 | `/file add <path>`, `/file list` |
| `/status` | 状态查看 | `/status`, `/status agent <id>` |

## 4. App CLI 交互能力

### 4.1 App 模块作为 CLI

`src/app/` 目录可直接作为 CLI 使用，提供交互能力:

```bash
# 直接运行 app 模块
node dist/app/index.js

# 或通过 finger 命令
finger app --interactive
finger app --prompt "任务描述"
```

### 4.2 App CLI 入口 (`src/app/cli.ts`)

```typescript
// 复用 finger 主 CLI 架构
export async function runAppCLI(args: string[]): Promise<void> {
  const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);

  if (args.includes('--interactive') || args.includes('-i')) {
    await startInteractiveMode(runtime);
  } else if (args.includes('--prompt') || args.includes('-p')) {
    const prompt = args[args.indexOf('--prompt') + 1] || args[args.indexOf('-p') + 1];
    await executeSinglePrompt(runtime, prompt);
  } else {
    showHelp();
  }
}

async function startInteractiveMode(runtime: RuntimeFacade): Promise<void> {
  // 类似 iflow 交互模式
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const input = await rl.question('> ');
    if (input.startsWith('/')) {
      await handleCommand(runtime, input);
    } else {
      await runtime.sendMessage(currentSessionId, input);
    }
  }
}
```

### 4.3 交互能力

- 会话管理: 创建、切换、恢复会话
- 消息发送: 文本、文件附件
- 命令执行: /command 内置命令
- 进度查看: 实时任务状态
- 中断恢复: Ctrl+C 中断，下次恢复

## 5. 文件存储结构

```
~/.finger/
├── sessions/
│   ├── <session-id>/
│   │   ├── session.json       # 元数据 + 消息索引
│   │   ├── messages.jsonl     # 消息流 (追加写入)
│   │   ├── plan.json          # 当前 Plan
│   │   ├── tasks.json         # 任务列表
│   │   ├── compressed/        # 压缩后的上下文
│   │   │   ├── summary-1.json
│   │   │   └── summary-2.json
│   │   └── files/             # 引用的文件快照
│   └── ...
└── workspace/
    └── <session-id>/          # 工作目录
        └── ...                # 运行时文件
```

## 6. 服务端 API

### 6.1 Session API

```
POST   /api/v2/sessions              // 创建会话
GET    /api/v2/sessions              // 列表
GET    /api/v2/sessions/:id          // 详情
PUT    /api/v2/sessions/:id          // 更新
DELETE /api/v2/sessions/:id          // 删除
POST   /api/v2/sessions/:id/messages // 发送消息
POST   /api/v2/sessions/:id/commands // 执行 /command
GET    /api/v2/sessions/:id/plan     // 获取 Plan
POST   /api/v2/sessions/:id/context/compress // 压缩上下文
```

### 6.2 Runtime API

```
GET    /api/v2/events/subscribe     // WebSocket 升级
GET    /api/v2/tools                // 工具列表
PUT    /api/v2/tools/:name/policy   // 设置工具策略
POST   /api/v2/tools/register       // 注册新工具
```

## 7. CLI 命令 (`finger session`)

```bash
finger session create --name="任务" --project=./app
finger session enter <id>              # 进入交互模式
finger session send <id> "消息"        # 非交互发送
finger session compress <id>           # 触发上下文压缩
finger session export <id> --format=json
finger session list --status=active
```

交互模式内命令:
```
/plan show
/task list
/tool allow <name>
/tool deny <name>
/context compress
/status
```

## 8. 与现有 Agent 集成

### 8.1 基础 Agent (使用 Facade)

```typescript
class ExecutorRole {
  constructor(private runtime: RuntimeFacade) {}

  async execute(task: Task): Promise<TaskResult> {
    await this.runtime.sendMessage(sessionId, `开始执行: ${task.title}`);
    const result = await this.runtime.callTool(this.agentId, 'execute', { task });
    return result;
  }
}
```

### 8.2 高级 Agent (直接 SDK + 事件发布)

```typescript
class OrchestratorRole {
  private adapter: IflowRuntimeAdapter;

  constructor(private client: IFlowClient, private eventBus: UnifiedEventBus) {
    this.adapter = new IflowRuntimeAdapter(client, eventBus);
  }

  async run(userMessage: string): Promise<OrchestrationResult> {
    await this.client.sendMessage(userMessage);
    for await (const msg of this.adapter.receiveMessagesWithEvents()) {
      // 处理消息...
      this.eventBus.emit({ type: 'workflow_progress', ... });
    }
  }
}
```

## 9. 测试策略

| 层级 | 测试内容 |
|------|----------|
| 单元测试 | UnifiedEventBus、ToolRegistry、ContextCompressor |
| 铃成测试 | RuntimeFacade + SessionManager、IflowRuntimeAdapter |
| E2E 测试 | CLI session 管理流程、WebSocket 事件订阅 |

## 10. BD 任务清单

- `finger-70`: Runtime Core - 统一事件总线与事件定义
- `finger-71`: Runtime Facade - Facade API 实现
- `finger-72`: Tool Registry - 最小策略工具注册表
- `finger-73`: iflow Runtime Adapter - SDK 事件适配器
- `finger-74`: Session Core 增强 - 压缩、Plan 管理、命令框架
- `finger-75`: CLI session 命令
- `finger-76`: WebSocket 事件订阅 API
- `finger-77`: 现有 Agent 集成改造
- `finger-78`: App CLI 交互入口
