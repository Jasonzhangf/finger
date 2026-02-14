# Agent 角色体系设计

## 核心概念

Agent 是任务的执行实体，每个 Agent 有特定角色、职责和专属提示词。Agent 通过 `iflow -p` / `codex -p` / `claude -p` 模式执行。

## 角色分类

### 1. Orchestrator (编排者) - 核心大脑

**职责**:
- 接收用户任务，进行任务分解
- 项目整体规划与管理
- 分配任务给合适的 Agent
- 监控整体进度，处理异常
- 决策：哪些任务并行，哪些串行
- 识别主设/非主设任务，安排执行顺序

**能力要求**:
- 强大的规划和推理能力
- 理解项目全局结构
- 熟悉 bd 项目管理

**提示词模板**:
```
你是 Orchestrator，一个任务编排专家。

你的职责：
1. 分析用户任务，分解为可执行的子任务
2. 识别任务依赖关系，标注主设(isMainPath=true)任务
3. 为每个子任务分配合适的执行者角色
4. 通过 ProjectBlock 同步任务到 bd
5. 监控进度，处理阻塞和异常

输出格式：
{
  "projectId": "...",
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "isMainPath": true/false,
      "dependencies": [],
      "assignedRole": "executor|reviewer|...",
      "priority": 0-9
    }
  ]
}

约束：
- 每个任务必须明确 isMainPath 标记
- 非主设任务优先调度
- 主设任务等待依赖完成后再执行
```

**对应的 CLI SDK**: Codex 或 Claude (最强推理能力)

---

### 2. Executor (执行者) - 任务执行

**职责**:
- 执行具体的子任务
- 编写代码、修改文件
- 运行测试，确保功能正确
- 报告执行结果和产出物

**能力要求**:
- 代码编写能力
- 工具使用能力（文件操作、命令执行）
- 测试验证能力

**提示词模板**:
```
你是 Executor，一个任务执行专家。

你的职责：
1. 接收具体任务描述
2. 执行必要的文件修改和代码编写
3. 运行测试验证结果
4. 报告完成状态和产出物

当前任务：
{{taskDescription}}

约束：
- 只修改任务相关的文件
- 必须运行测试验证
- 遇到阻塞立即报告

输出格式：
{
  "status": "completed|failed|blocked",
  "changes": ["file1.ts", "file2.ts"],
  "testResult": "passed|failed",
  "artifacts": [],
  "message": "..."
}
```

**对应的 CLI SDK**: Codex 或 iflow (执行能力强)

---

### 3. Reviewer (检查者) - 质量把关

**职责**:
- 审查 Executor 的产出
- 检查代码质量、规范遵守
- 验证任务是否满足验收标准
- 提出改进建议或标记问题

**能力要求**:
- 代码审查能力
- 规范理解能力
- 测试设计能力

**提示词模板**:
```
你是 Reviewer，一个质量检查专家。

你的职责：
1. 审查任务产出的代码和文件
2. 检查是否遵循项目规范 (AGENTS.md)
3. 验证是否满足任务的验收标准
4. 评估测试覆盖率和质量

待审查的任务：
{{taskDescription}}

产出物：
{{artifacts}}

审查清单：
- [ ] 代码符合项目规范
- [ ] 测试通过
- [ ] 无明显 bug
- [ ] 满足验收标准

输出格式：
{
  "approved": true/false,
  "issues": [
    {
      "severity": "critical|major|minor",
      "file": "...",
      "line": 123,
      "description": "...",
      "suggestion": "..."
    }
  ],
  "summary": "..."
}
```

**对应的 CLI SDK**: Claude (审查细致)

---

### 4. Specialist (专家) - 领域专精

根据项目需要，可以有多个专家角色：

#### 4.1 Architect (架构师)
```
职责：设计系统架构、模块划分、接口定义
能力：理解复杂系统，权衡技术选型
SDK：Claude 或 Codex
```

#### 4.2 Tester (测试工程师)
```
职责：编写测试用例、设计测试策略
能力：边界条件分析、覆盖率优化
SDK：Codex
```

#### 4.3 DocWriter (文档工程师)
```
职责：编写文档、API 说明、使用指南
能力：清晰表达、结构化写作
SDK：Claude
```

#### 4.4 SecurityAuditor (安全审计员)
```
职责：检查安全漏洞、权限问题
能力：安全知识、渗透测试
SDK：Claude
```

---

## 角色工作流程

```
用户输入
    │
    ▼
┌─────────────────┐
│  Orchestrator   │ ← 分析、分解、分配
└────────┬────────┘
         │
    ┌────▼────┬─────────┬─────────┐
    ▼         ▼         ▼         ▼
┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐
│Exec #1│ │Exec #2│ │Exec #3│ │Spec #N│
└───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘
    │         │         │         │
    ▼         ▼         ▼         ▼
┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐
│Review │ │Review │ │Review │ │Review │
│  #1   │ │  #2   │ │  #3   │ │  #N   │
└───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘
    │         │         │         │
    └─────────┴─────────┴─────────┘
                  │
                  ▼
         ┌─────────────────┐
         │  Orchestrator   │ ← 汇总、决策
         └─────────────────┘
                  │
                  ▼
              ���成/回滚
```

---

## 角色与 Block 的映射

| 角色 | 主要交互 Block | CLI SDK |
------|----------------|---------|
| Orchestrator | OrchestratorBlock, ProjectBlock, TaskBlock | Codex/Claude |
| Executor | TaskBlock, StorageBlock | Codex/iflow |
| Reviewer | TaskBlock, EventBusBlock | Claude |
| Architect | ProjectBlock | Claude/Codex |
| Tester | TaskBlock | Codex |
| DocWriter | StorageBlock | Claude |

---

## Agent 实例管理

### AgentBlock 职责

```typescript
interface AgentInstance {
  id: string;
  role: 'orchestrator' | 'executor' | 'reviewer' | 'specialist';
  specialistType?: 'architect' | 'tester' | 'docwriter' | 'security';
  sdk: 'iflow' | 'codex' | 'claude';
  status: 'idle' | 'busy' | 'error';
  currentTask?: string;
  capabilities: string[];
  promptTemplate: string;
}

// AgentBlock 提供的能力
{
  functions: [
    'spawnAgent',      // 创建 Agent 实例
    'assignTask',      // 分配任务
    'getAgentStatus',  // 获取状态
    'killAgent',       // 终止 Agent
    'listAgents'       // 列出所有实例
  ],
  cli: [
    'finger agent spawn --role executor --sdk codex',
    'finger agent list',
    'finger agent status <id>',
    'finger agent assign <id> --task <taskId>',
    'finger agent kill <id>'
  ]
}
```

---

## 任务分配策略

### Orchestrator 的分配逻辑

1. **角色匹配**:
   - 架构设计 → Architect
   - 代码实现 → Executor
   - 测试编写 → Tester
   - 代码审查 → Reviewer
   - 文档编写 → DocWriter

2. **SDK 选择**:
   - 需要强推理 → Claude/Codex
   - 需要快速执行 → iflow/Codex
   - 需要细致审查 → Claude

3. **并行/串行决策**:
   - 非主设任务 → 并行执行
   - 主设任务 → 串行执行（等待依赖）

4. **负载均衡**:
   - 检查 Agent 状态
   - 优先分配给 idle 的 Agent
   - 避免单个 Agent 过载

---

## 示例场景

### 场景：实现一个新功能

```
用户："实现用户登录功能"

1. Orchestrator 分解任务：
   - Task#1: 设计登录模块架构 (isMainPath=false, role=architect)
   - Task#2: 实现登录 API (isMainPath=true, role=executor, depends=Task#1)
   - Task#3: 编写单元测试 (isMainPath=false, role=tester, parallel with Task#2)
   - Task#4: 代码审查 (isMainPath=false, role=reviewer, depends=Task#2,Task#3)
   - Task#5: 编写文档 (isMainPath=false, role=docwriter, depends=Task#4)

2. 调度执行：
   - Round 1: Task#1 (architect), Task#3 (tester) 并行
   - Round 2: Task#2 (executor) - 等待 Task#1 完成
   - Round 3: Task#4 (reviewer) - 等待 Task#2, Task#3 完成
   - Round 4: Task#5 (docwriter) - 等待 Task#4 完成

3. 每个 Executor/Reviewer 通过 -p 模式执行
```

---

## 提示词变量系统

每个角色的提示词模板支持变量替换：

```typescript
interface PromptVariables {
  // 任务相关
  taskDescription: string;
  taskId: string;
  projectId: string;
  
  // 项目上下文
  projectContext: string;      // 从 AGENTS.md 读取
  blockCapabilities: string;   // 从 BlockRegistry 获取
  
  // 依赖信息
  dependencies: Task[];
  artifacts: string[];
  
  // 审查专用
  codeChanges?: string;
  acceptanceCriteria?: string;
}

// AIBlock 负责变量替换和 SDK 调用
```

---

## 待确认问题

1. **角色数量**：当前设计了 4 大类 + 4 专家，是否需要更多/更少？
2. **SDK 映射**：各角色对应的 SDK 是否合理？
3. **提示词深度**：提示词模板是否需要更详细的约束？
4. **并行粒度**：非主设任务是否需要限制最大并行数？
5. **失败处理**：Executor 失败后，是否自动重试或切换 SDK？
