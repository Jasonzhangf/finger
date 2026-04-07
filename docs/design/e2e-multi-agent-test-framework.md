# 多 Agent 协同 E2E 测试框架设计

> 状态: 设计完成，待实施
> 创建时间: 2026-04-07
> 参考: finger-276 多 Agent 协同实现

## 1. 概述

### 1.1 测试理念

**不是刚性调用 API**，而是通过 **自然语言 Prompt 触发 System Agent 自主决策**，
用 Tool Call Hook 拦截观测，用 4 层 Observer 收集证据，用 Assertion Engine 自动断言。

### 1.2 核心原则

1. **Prompt 驱动**：测试输入是自然语言，不是函数调用
2. **Hook 拦截**：通过 Tool Call Hook 拦截所有工具调用，支持观测和注入
3. **观测分离**：Ledger/Mailbox/Registry/Resource 4 层独立观测
4. **故障注入**：支持延迟/失败/超时注入，验证异常恢复能力
5. **迭代优化**：每轮测试结果反馈到框架调整

## 2. 框架架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    E2E Test Framework                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 1. Prompt Driver (测试触发器)                              │   │
│  │    - 预设 Prompt 模板库                                     │   │
│  │    - 动态变量注入                                          │   │
│  │    - 场景编排（多轮对话）                                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 2. Tool Call Hook (强 Hook - 观测 + 控制)                  │   │
│  │    - 拦截所有 tool_call/tool_result                       │   │
│  │    - 记录调用链                                            │   │
│  │    - 支持注入/修改参数                                     │   │
│  │    - 支持延迟/失败注入                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 3. Observation Layer (观测层)                              │   │
│  │    - Ledger Observer (事件流)                             │   │
│  │    - Mailbox Observer (通信)                              │   │
│  │    - Registry Observer (Agent 状态)                        │   │
│  │    - Resource Observer (内存/CPU)                         │   │
│  └──────────��───────────────────────────────────────────────┘   │
│                            │                                     │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 4. Assertion Engine (断言引擎)                             │   │
│  │    - 基于观测数据自动断言                                  │   │
│  │    - 超时检测                                              │   │
│  │    - 死锁检测                                              │   │
│  │    - 生成测试报告                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 3. 核心组件

### 3.1 Tool Call Hook

**接口定义**：

```typescript
export interface ToolCallHook {
  // 调用前拦截（可修改参数/拒绝调用）
  beforeCall: (toolName: string, params: Record<string, unknown>) => 
    | { allowed: true; params: Record<string, unknown> }
    | { allowed: false; reason: string };
  
  // 调用后拦截（可修改结果）
  afterCall: (toolName: string, result: unknown) => unknown;
  
  // 异常拦截
  onError: (toolName: string, error: Error) => void;
}

// 全局 Hook 注册表
const toolCallHooks = new Map<string, ToolCallHook[]>();

// 注册 Hook
export function registerToolCallHook(toolName: string, hook: ToolCallHook): void;

// 执行时触发 Hook
export async function executeWithHooks<T>(
  toolName: string,
  fn: () => Promise<T>,
  originalParams: Record<string, unknown>
): Promise<T>;

// 清理所有 Hook
export function clearAllHooks(): void;
```

### 3.2 Observation Layer

#### Ledger Observer

```typescript
export class LedgerObserver {
  start(): void;
  getNewEvents(): LedgerEntryFile[];
  assertEventHappened(eventType: string, timeoutMs: number): Promise<void>;
  assertToolCalled(toolName: string, timeoutMs: number): Promise<void>;
  getEventTimeline(): EventTimeline[];
}
```

#### Mailbox Observer

```typescript
export class MailboxObserver {
  getNewMessages(sinceSeq: number): MailboxEnvelope[];
  assertInterAgentReceived(from: string, timeoutMs: number): Promise<void>;
  assertCompletionReceived(childId: string, timeoutMs: number): Promise<void>;
  assertMessageCount(category: string, expected: number, timeoutMs: number): Promise<void>;
}
```

#### Registry Observer

```typescript
export class RegistryObserver {
  getActiveAgents(): AgentMetadata[];
  assertAgentCount(expected: number, timeoutMs: number): Promise<void>;
  assertConcurrentExecution(minConcurrent: number, timeoutMs: number): Promise<void>;
  assertAgentCompleted(agentId: string, timeoutMs: number): Promise<void>;
}
```

#### Resource Observer

```typescript
export class ResourceObserver {
  start(sampleIntervalMs?: number): void;
  stop(): void;
  assertMemoryGrowthLessThan(thresholdMB: number): void;
  getPeakMemory(): number;
  getMemoryTimeline(): MemorySample[];
}
```

### 3.3 Prompt Driver

```typescript
export interface PromptTemplate {
  id: string;
  name: string;
  template: string;
  variables?: Record<string, string>;
}

export class PromptDriver {
  // 发送 prompt 给 System Agent
  sendPrompt(template: PromptTemplate): Promise<string>;
  
  // 等待 System Agent 回复
  waitForResponse(timeoutMs: number): Promise<string>;
  
  // 多轮对话
  multiTurn(turns: PromptTemplate[]): Promise<string[]>;
}
```

### 3.4 Assertion Engine

```typescript
export class AssertionEngine {
  // 通用等待条件
  waitForCondition(
    condition: () => boolean,
    timeoutMs: number,
    message: string
  ): Promise<void>;
  
  // 生成测试报告
  generateReport(): TestReport;
}

export interface TestReport {
  scenario: string;
  prompt: string;
  timeline: EventTimeline[];
  assertions: AssertionResult[];
  memorySnapshot: MemorySample[];
  resourceGrowth: number;
  duration: number;
  passed: boolean;
}
```

### 3.5 故障注入

```typescript
export class FailureInjector {
  // 注入延迟
  injectDelay(toolName: string, delayMs: number): void;
  
  // 注入失败（按概率）
  injectFailure(toolName: string, failureRate: number): void;
  
  // 注入超时
  injectTimeout(toolName: string, timeoutMs: number): void;
  
  // 参数篡改
  injectParamOverride(toolName: string, paramKey: string, newValue: unknown): void;
  
  // 清理所有注入
  clearAll(): void;
}
```

## 4. 测试场景

### 场景 1：简单任务单 Agent

**Prompt**：
> "帮我分析当前 finger 项目的日志结构，列出所有模块的日志覆盖情况"

**预期流**：
```
用户 → System Agent → 直接执行（无 spawn）→ 返回结果
```

**观测清单**：
| 时间点 | 观测 | 预期 | 数据源 |
|--------|------|------|--------|
| Prompt 后 | System Agent 开始推理 | `turn_start` 事件 | Ledger |
| 执行中 | 无 spawn 调用 | `agent.spawn` 不出现 | Hook |
| 完成 | turn_complete | `finish_reason=stop` | Ledger |
| 资源 | 内存平稳 | growth < 5MB | Resource |

### 场景 2：复杂任务多 Agent 并行

**Prompt**：
> "帮我对 finger 项目进行代码审查：
> 1. 分析 `src/blocks/` 的测试覆盖率
> 2. 检查 `src/orchestration/` 的内存泄露隐患
> 3. 审查 `src/tools/internal/` 工具实现
> 请同时开始这三项审查"

**预期流**：
```
用户 → System Agent
  ├─ spawn worker-1 (blocks-test-coverage)
  ├─ spawn worker-2 (orchestration-memory)
  ├─ System Agent 自身做 tools-review
  ├─ 等待完成
  └─ 汇总返回
```

**观测清单**：
| 时间点 | 观测 | 预期 | 数据源 |
|--------|------|------|--------|
| spawn 后 | Registry 增加 2 agents | count == 2 | Registry |
| 执行中 | 2 agents 并发 running | concurrent >= 2 | Registry |
| 子完成 | Notification 到 parent | completion 事件 | Mailbox |
| 汇总 | 最终回复含 3 个结果 | assistant message | Ledger |
| 清理 | Registry 清空 | count == 0 | Registry |
| 资源 | 内存增长 < 10MB | growth < 10MB | Resource |

### 场景 3：动态任务分解

**Prompt**：
> "从 datareportal.com 下载最新的年度报告，保存到 ~/Documents/reports/，然后提取关键数据做摘要"

**预期流**：
```
用户 → System Agent → 分步执行（搜索→下载→摘要）→ 返回结果
```

**观测清单**：
| 时间点 | 观测 | 预期 |
|--------|------|------|
| 步骤间 | 状态传递 | 每步有进度更新 |
| 完成 | 文件存在 | ~/Documents/reports/ 有文件 |
| 资源 | 内存平稳 | growth < 5MB |

### 场景 4：子 Agent 间通信

**Prompt**：
> "派一个 agent 分析 webauto 项目的任务队列状况，同时派另一个检查 finger 项目的 heartbeat 状态，然后汇总两个项目的健康状况"

**预期流**：
```
用户 → System Agent
  ├─ spawn agent-1 (webauto)
  ├─ spawn agent-2 (finger-heartbeat)
  ├─ 两个 agent 并行执行
  ├─ 各自通过 mailbox 通知完成
  └─ 汇总健康报告
```

**观测清单**：
| 时间点 | 观测 | 预期 | 数据源 |
|--------|------|------|--------|
| spawn 后 | 2 agents running | count == 2 | Registry |
| 通信 | InterAgentCommunication | triggerTurn=false | Mailbox |
| 完成 | CompletionNotification | 2 个通知 | Mailbox |
| 汇总 | 包含两个项目信息 | assistant message | Ledger |

### 场景 5：异常场景

**Prompt A（超时）**：
> "下载一个不存在的网站数据，持续尝试直到完成"

**预期**：Agent 失败 + 系统报告失败 + 资源释放

**Prompt B（故障注入）**：
> "分析 finger 项目的测试覆盖率"

**预期**：注入 agent.spawn 延迟 5s → Agent 等待 → 最终完成

## 5. 文件结构

```
tests/e2e/
├── framework/
│   ├── agent-collab-framework.ts    # 主框架入口
│   ├── prompt-driver.ts             # Prompt 驱动
│   ├── assertion-engine.ts          # 断言引擎
│   └── test-report.ts               # 测试报告生成
├── observers/
│   ├── ledger-observer.ts           # Ledger 观测
│   ├── mailbox-observer.ts          # Mailbox 观测
│   ├── registry-observer.ts         # Registry 观测
│   └── resource-observer.ts         # 资源观测
├── hooks/
│   ├── tool-call-hook.ts            # Tool Call Hook 基础设施
│   ├── injection-hooks.ts           # 参数注入 Hook
│   └── failure-injection.ts         # 故障注入 Hook
├── scenarios/
│   ├── scenario-1-single-agent.ts
│   ├── scenario-2-parallel-agents.ts
│   ├── scenario-3-dynamic-decomposition.ts
│   ├── scenario-4-inter-agent-comm.ts
│   └── scenario-5-error-handling.ts
└── fixtures/
    ├── prompts.ts                   # Prompt 模板
    └── expectations.ts              # 预期结果定义
```

## 6. 实施计划

| Phase | 任务 | 依赖 | 预计 |
|-------|------|------|------|
| 1 | Tool Call Hook 基础设施 | 无 | 30min |
| 2 | 4 个 Observer 实现 | 无 | 40min |
| 3 | Prompt Driver + Assertion Engine | Phase 1,2 | 30min |
| 4 | 场景 1-2 实现 + 测试 | Phase 3 | 40min |
| 5 | 场景 3-5 实现 + 测试 | Phase 4 | 40min |
| 6 | 故障注入 Hook | Phase 1 | 20min |
| 7 | 测试报告生成 | Phase 5 | 20min |
| 8 | 迭代优化（根据测试结果调整） | Phase 5 | 60min |

## 7. 迭代优化机制

每轮测试后：
1. 收集测试报告（自动生成）
2. 分析失败原因（Hook 记录 + Observer 数据）
3. 调整框架（Observer 精度、Hook 注入策略、Prompt 模板）
4. 重新执行验证

---

## 9. 核心原则修正（2026-04-07）

### 9.1 错误的做法（之前做的）

```typescript
// 假的。我自己造数据，自己验证。没经过 Agent，没经过推理。
registry.register({ id: 'worker-001', ... });
expect(registryObs.getActiveAgents()).toHaveLength(1);
```

**这种测试验证的是我自己写的代码，不是 Agent 的行为。毫无意义。**

---

### 9.2 正确的做法

**核心理念：Prompt 是输入，锚点是观测，Agent 是黑盒**

Agent 是不可控的大模型推理链路。我们不能假设它会调什么函数、走什么路径。我们能做的只有：

1. **发 Prompt**（我们可控）
2. **设锚点**（我们可观测）
3. **等 Agent 自己走完**（黑盒）
4. **检查锚点是否被触发**（验证结果）
5. **根据结果调整 Prompt**（迭代优化）

---

### 9.3 完整流程

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 设计 Prompt + 预期锚点                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Prompt: "帮我对 finger 项目进行代码审查：                          │
│         1. 分析 src/blocks/ 测试覆盖率                            │
│         2. 检查 src/orchestration/ 内存泄露                       │
│         请同时开始这两项审查"                                      │
│                                                                  │
│ 预期锚点（不是刚性断言，是观测信号）：                              │
│   A1: daemon.log 出现 "agent.spawn" 或类似 spawn 行为             │
│   A2: daemon.log 出现 2 个不同的 dispatch（并发）                 │
│   A3: mailbox 收到 completion notification                       │
│   A4: 最终回复包含 2 个子任务的结果                                │
│   A5: 整体耗时 < 5 分钟                                          │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: 发送 Prompt 到真实 Daemon                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ POST http://localhost:9999/api/v1/channels/send                  │
│ { channel: 'qqbot', message: prompt }                            │
│                                                                  │
│ 然后等待。不干预 Agent 的推理过程。                                │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: 实时观测锚点（轮询 daemon.log / ledger / mailbox）        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Observer 轮询（不是 Mock）：                                      │
│   LedgerObserver:                                               │
│     tail -f ~/.finger/sessions/.../context-ledger.jsonl          │
│     → 检查是否出现 dispatch/spawn/tool_call 事件                 │
│                                                                  │
│   MailboxObserver:                                               │
│     GET http://localhost:9999/api/v1/mailbox/finger-system-agent │
│     → 检查是否有 inter_agent/completion 消息                     │
│                                                                  │
│   InteractionObserver:                                           │
│     pnpm exec tsx scripts/observe-interactions.ts <sessionId>   │
│     → 生成交互流程图，查看 Agent 行为                             │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3.5: Agent 没有按预期走？                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ 场景：Agent 没有选择 spawn 子 agent，而是自己串行执行了           │
│                                                                  │
│ 可能原因：                                                        │
│   - Prompt 不够明确（没有说"同时开始"）                           │
│   - System prompt 没有引导 spawn 行为                             │
│   - Agent 觉得任务不够复杂不需要 spawn                            │
│                                                                  │
│ 解决：调整 Prompt                                                 │
│   - 更明确的指示："请派 2 个 agent 分别负责"                      │
│   - 或调整 System Prompt 引导 spawn 行为                         │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: 生成测试报告                                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ 报告内容：                                                        │
│   - Prompt 原文                                                  │
│   - Agent 实际行为（从日志提取）                                   │
│   - 锚点命中情况（哪些触发了，哪些没触发）                        │
│   - 耗时、token 消耗                                             │
│   - Prompt 改进建议                                              │
│                                                                  │
│ 示例：                                                            │
│   ┌──────────────────────────────────────────────────────┐      │
│   │ Test Report: scenario-2-parallel-agents              │      │
│   │ Prompt: "帮我对 finger 项目进行代码审查..."            │      │
│   │                                                       │      │
│   │ Anchors:                                              │      │
│   │   A1 (spawn detected): ✅ HIT                         │      │
│   │   A2 (concurrent dispatch): ✅ HIT (2 dispatches)    │      │
│   │   A3 (completion notification): ✅ HIT               │      │
│   │   A4 (aggregated result): ❌ MISS - Agent 自行完成了  │      │
│   │   A5 (duration < 5min): ✅ HIT (3m 22s)              │      │
│   │                                                       │      │
│   │ Agent actual behavior:                                │      │
│   │   - Did NOT spawn child agents                        │      │
│   │   - Executed tasks sequentially                       │      │
│   │   - Used grep/cat tools directly                      │      │
│   │                                                       │      │
│   │ Prompt improvement:                                   │      │
│   │   - Add "请派 2 个 agent 并行执行"                    │      │
│   │   - Add "不要自己执行，必须委派"                       │      │
│   └──────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

---

### 9.4 InteractionObserver - 真实 E2E 观测工具

**不是 Mock，是从真实 ledger 文件提取事件**。

#### 用法

```bash
# 自动找最新 session
pnpm exec tsx scripts/observe-interactions.ts

# 指定 session
pnpm exec tsx scripts/observe-interactions.ts hb-session-finger-system-agent-global

# 持续观测模式
pnpm exec tsx scripts/observe-interactions.ts --watch
```

#### 输出示例

```
Session: hb-session-finger-system-agent-global
Agents found: 1
  finger-system-agent (5.94 MB)

┌──────────────────────────────────────────────────────────────────────┐
│                Agent Interaction Flow Diagram                        │
├──────────────────────────────────────────────────────────────────────┤
│ Session: hb-session-finger-system-agent-global
│ Agents:  finger-system-agent
│ Total Events:  2775
│ Key Events:    2009
│ Interactions:  0
│ Duration:      398733.1s
├──────────────────────────────────────────────────────────────────────┤
│ INTERACTIONS:
│ +0.5s   system_agent ──spawn────► worker-1
│ +0.6s   system_agent ──spawn────► worker-2
│ +12.3s  worker-1 ◄──done────── system_agent
│ +15.7s  worker-2 ◄──done────── system_agent
├──────────────────────────────────────────────────────────────────────┤
│ KEY EVENTS:
│ +0.0s      turn_start           (finger-system-agent)
│ +12.7s     tool_call            [mailbox.read] (finger-system-agent)
│ +36.5s     tool_call            [reasoning.stop] (finger-system-agent)
│ ...
└──────────────────────────────────────────────────────────────────────┘
```

#### 支持的事件类型

| 事件类型 | 说明 | 提取字段 |
|---------|------|---------|
| `spawn` | agent.spawn 工具调用 | from, to (target) |
| `dispatch` | AgentRuntimeBlock dispatch | from, to (target) |
| `send_message` | agent.send_message 工具调用 | from, to, triggerTurn |
| `followup_task` | agent.followup_task 工具调用 | from, to, triggerTurn |
| `completion` | AgentCompletionNotification | from (child), to (parent) |
| `mailbox` | InterAgentCommunication | from, to, triggerTurn |
| `tool_call` | 通用工具调用 | toolName, agentId |
| `turn_start` | 推理开始 | agentId |
| `turn_complete` | 推理结束 | agentId |

---

### 9.5 关键区别总结

| | 错误做法（之前） | 正确做法（修正后） |
|---|---|---|
| **数据来源** | 手动造 Mock 数据 | Agent 真实推理产生 |
| **验证对象** | Mock 对象 | daemon.log / ledger / mailbox |
| **Agent 参与** | 无 | 完整推理链路 |
| **可发现的问题** | 框架代码 bug | Prompt 不够引导、Agent 不按预期走 |
| **迭代方向** | 无 | 调整 Prompt + 锚点 |
| **测试工具** | Mock Registry/Mailbox | InteractionObserver（真实 ledger） |

---

## 10. 变更记录

| 日期 | 变更 | 说明 |
|------|------|------|
| 2026-04-07 | Section 9 核心原则修正 | 从 Mock 测试 → 真实 E2E 观测 |
| 2026-04-07 | Section 9.4 InteractionObserver | 新增真实 ledger 观测工具 |
| 2026-04-07 | 脚本 observe-interactions.ts | 新增交互流程图生成工具 |
