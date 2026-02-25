# Router Architecture - 双层路由架构

## 核心概念

路由系统分为两个独立但协作的层面：

### 1. 消息路由层 (Message Hub) - 通信层面
**职责：** 消息的物理传输和转发
- 输入/输出接口注册
- 消息队列管理
- 阻塞/非阻塞模式
- 回调机制

**实现：** `src/orchestration/message-hub.ts`

```
┌──────────────┐         ┌──────────────┐
│ Input Module │ ──────► │ Message Hub  │
└──────────────┘         └──────┬───────┘
                                │
                         [消息匹配/转发]
                                │
                                ▼
                       ┌──────────────┐
                       │ Output Module│
                       └──────────────┘
```

### 2. 语义路由层 (Semantic Router) - 决策层面
**职责：** 理解意图并决策路由方向
- 调用 LLM 分析用户输入
- 意图分类 (Classification)
- 根据处理能力选择目标
- 返回路由决策

**实现：** `src/agents/router/router-agent.ts`

```
用户输入
    ↓
┌─────────────────┐
│ 语义理解 (LLM)   │ ← 意图识别
│ Classification  │
└────────┬────────┘
         │
    ┌────┴────────────────────┐
    │  决策引擎               │
    │  - 匹配处理能力          │
    │  - 选择目标 Agent        │
    └────┬────────────────────┘
         │
    ┌────▼────┐
    │ 路由决策 │ → 返回给 Message Hub
    └─────────┘
```

## 双层协作流程

```
1. 用户输入
       ↓
2. Message Hub 接收 (消息路由层)
       ↓
3. Router Agent 处理 (语义路由层)
       ├─ 调用 LLM 分析意图
       ├─ Classification 分类
       └─ 决策目标 Agent
       ↓
4. Message Hub 转发到目标 (消息路由层)
       ↓
5. 目标 Agent 处理
       ↓
6. 结果返回用户
```

## 详细设计

### 消息路由层 (Message Hub)

**核心接口：**
```typescript
interface MessageHub {
  // 注册输入/输出
  registerInput(id: string, handler: MessageHandler): void;
  registerOutput(id: string, handler: OutputHandler): void;
  
  // 消息发送
  send(message: Message): Promise<void>;
  sendToModule(moduleId: string, message: Message): Promise<any>;
  
  // 路由规则
  addRoute(route: RouteEntry): string;
}
```

**特点：**
- 不关心消息内容语义
- 只负责根据规则转发
- 支持阻塞/非阻塞
- 处理回调和状态

### 语义路由层 (Router Agent)

**核心接口：**
```typescript
interface SemanticRouter {
  // 意图分析
  analyzeIntent(input: string): Promise<Intent>;
  
  // 分类决策
  classify(intent: Intent): Promise<Classification>;
  
  // 路由决策
  decide(classification: Classification): RouteDecision;
}

interface RouteDecision {
  intent: string;           // 识别的意图
  confidence: number;       // 置信度
  targetModule: string;     // 目标模块
  capabilities: string[];   // 需要的处理能力
  reasoning: string;        // 决策理由
}
```

**特点：**
- 理解消息语义
- 调用 LLM 进行分类
- 根据系统能力决策
- 返回路由指令

## 分类体系

### 意图分类 (Intent Classification)

```typescript
enum IntentType {
  // 通用问答
  CHAT = 'chat',
  KNOWLEDGE = 'knowledge',
  
  // 任务执行
  CODE_CREATE = 'code.create',
  CODE_MODIFY = 'code.modify',
  CODE_DELETE = 'code.delete',
  CODE_REVIEW = 'code.review',
  
  // 文件操作
  FILE_READ = 'file.read',
  FILE_WRITE = 'file.write',
  
  // 研究搜索
  RESEARCH = 'research',
  
  // 系统命令
  SYSTEM = 'system',
}
```

### 处理能力映射

```typescript
const CAPABILITY_MAP = {
  'chat': ['conversation'],
  'knowledge': ['knowledge-base'],
  'code.create': ['file-write', 'code-generation'],
  'code.modify': ['file-read', 'file-write', 'code-understanding'],
  'code.review': ['code-understanding', 'best-practices'],
  'file.read': ['file-read'],
  'file.write': ['file-write'],
  'research': ['web-search', 'document-analysis'],
  'system': ['system-control'],
};
```

## 完整调用链

```
用户输入
    │
    ▼
┌─────────────────────────────────┐
│  Message Hub (消息路由层)        │
│  - 接收消息                     │
│  - 匹配 router-input            │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  Router Agent (语义路由层)       │
│  1. 接收消息                    │
│  2. 调用 LLM 分析意图            │
│  3. Classification 分类          │
│  4. 匹配处理能力                │
│  5. 返回 RouteDecision          │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  Message Hub (消息路由层)        │
│  - 根据 decision.targetModule   │
│  - 转发到目标 Agent              │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  Target Agent (任务处理)         │
│  - Task Orchestrator            │
│  - Chat Agent                   │
│  - Research Agent               │
└─────────────────────────────────┘
```

## 代码示例

### Router Agent 实现

```typescript
export class RouterAgent {
  async handleInput(message: RouterMessage): Promise<RouteDecision> {
    // 1. 语义理解层 - 调用 LLM
    const intent = await this.analyzeIntent(message.text);
    
    // 2. 分类层 - 确定意图类别
    const classification = this.classify(intent);
    
    // 3. 决策层 - 匹配处理能力
    const decision = this.decide(classification);
    
    // 4. 返回决策给 Message Hub
    return decision;
  }
  
  private async analyzeIntent(text: string): Promise<Intent> {
    const prompt = this.buildPrompt(text);
    const response = await this.callLLM(prompt);
    return this.parseResponse(response);
  }
  
  private classify(intent: Intent): Classification {
    // 根据意图匹配预定义分类
    return INTENT_CLASS_MAP[intent.type] || Classification.TASK;
  }
  
  private decide(classification: Classification): RouteDecision {
    // 根据分类和系统能力决策
    const capabilities = CAPABILITY_MAP[classification];
    const targetModule = this.findModuleWithCapabilities(capabilities);
    
    return {
      intent: classification,
      targetModule,
      capabilities,
      confidence: 0.9,
      reasoning: '...',
    };
  }
}
```

## 扩展性

### 添加新分类

1. 在 `IntentType` 枚举中添加新意图
2. 在 `CAPABILITY_MAP` 中定义所需能力
3. 更新 Router 的 system prompt
4. Router 自动支持新分类

### 添加新 Agent

1. 实现 Agent 并声明能力
2. 注册到 Message Hub
3. Router 自动发现并路由

## 监控与调试

```typescript
// 日志输出
[Router] Received input: "创建新组件"
[Router] LLM Intent: { type: "code.create", confidence: 0.95 }
[Router] Classification: CODE_CREATE
[Router] Required capabilities: ["file-write", "code-generation"]
[Router] Target module: task-orchestrator
[Router] Decision: route to task-orchestrator
```

## 性能优化

1. **意图缓存** - 相似输入缓存分类结果
2. **批量分类** - 多个输入批量调用 LLM
3. **降级策略** - LLM 不可用时 fallback 到规则
4. **预分类** - 简单规则预过滤，减少 LLM 调用
