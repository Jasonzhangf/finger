# Project Agent 内部多 Agent 协同设计文档

> Epic: finger-276
> 创建时间: 2026-04-06
> 状态: 设计中
> 参考: ~/code/codex 多 Agent 协同架构（Codex Rust）

## 1. 概述

在保持 System Agent → Project Agent 派发架构不变的前提下，为 Project Agent 内部添加类似 Codex 的 **LLM 工具驱动多 agent 协同能力**。

### 1.1 两级架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Level 1: System Agent → Project Agent                           │
│   - 保持当前派发架构                                             │
│   - System Agent 不管理 Project Agent 内部任务细节               │
│   - System Agent 只委任 Project Agent 作为 "leader"             │
├────────────────���────────────────────────────────────────────────┤
│ Level 2: Project Agent 内部（借鉴 Codex）                        │
│   - LLM 工具驱动：spawn/wait/send/followup/close/list           │
│   - 层级路径命名：/root/explorer/worker                          │
│   - Fork 历史继承                                                │
│   - Completion Watcher 自动通知                                  │
│   - Mailbox trigger_turn 机制                                    │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 设计决策（已确认）

| 决策点 | 选择 | 说明 |
|--------|------|------|
| 历史继承 (Fork) | 支持 FullHistory/LastNTurns | 子 agent 继承精华历史 |
| 命名方式 | 层级路径 | `/root/explorer/worker`，支持相对引用 |
| trigger_turn | 需要 | 区分 send_message（队列）vs followup_task（触发） |
| Completion Watcher | 需要 | 子 agent 完成后自动通知父 mailbox |
| 并发控制 | max_threads=10, max_depth=3 | 可配置 |

## 2. 核心组件

### 2.1 Agent 层级路径系统（AgentPath）

**位置**: `src/common/agent-path.ts`

```typescript
class AgentPath {
  static ROOT = '/root';
  
  private constructor(private path: string);
  
  // 工厂方法
  static root(): AgentPath;
  static fromSegments(...segments: string[]): AgentPath;
  
  // 路径操作
  name(): string;                    // 最后一段 "worker"
  parent(): AgentPath | null;        // 父路径
  join(segment: string): AgentPath;  // 添加子路径
  resolve(reference: string): AgentPath; // 相对引用 ../sibling, ./child
  
  // 验证
  static isValid(path: string): boolean;
  isRoot(): boolean;
  
  // 序列化
  toString(): string;
}
```

**验证规则**:
- 必须以 `/root` 开头
- segment 只能使用 `[a-z][a-z0-9_]*`
- 不能使用 `root/.` `..` 作为 segment

### 2.2 AgentRegistry 并发控制

**位置**: `src/orchestration/agent-registry.ts`

```typescript
interface AgentMetadata {
  agentId: string;
  agentPath: AgentPath;
  nickname: string;
  role: string;
  status: AgentStatus;
  lastTaskMessage?: string;
}

class AgentRegistry {
  private activeAgents: Map<string, AgentMetadata>;
  private totalCount: number;
  private usedNicknames: Set<string>;
  private nicknameResetCount: number;
  
  reserveSpawnSlot(maxThreads: number): SpawnReservation;
  reserveNickname(role: string): string;
  registerPath(path: AgentPath, metadata: AgentMetadata): void;
  nextDepth(parentDepth: number): number;
  exceedsDepthLimit(depth: number, maxDepth: number): boolean;
  getAgentByPath(path: AgentPath): AgentMetadata | undefined;
  listAgents(prefix?: string): AgentMetadata[];
}

class SpawnReservation {
  private committed: boolean = false;
  commit(metadata: AgentMetadata): void;
  [Symbol.dispose](): void;  // 未 commit 时自动回滚
}
```

**配置** (orchestration.json):
```json
{
  "collab": {
    "maxThreads": 10,
    "maxDepth": 3,
    "nicknameCandidates": {
      "explorer": ["Darwin", "Nova", "Atlas", "Orion", "Luna"],
      "worker": ["Alex", "Maya", "Leo", "Nora", "Iris"],
      "default": ["Codex", "Echo", "Flux", "Nova", "Orion"]
    }
  }
}
```

### 2.3 Mailbox 增强

**位置**: `src/blocks/mailbox-block/protocol.ts` + `index.ts`

```typescript
// 新增 InterAgentCommunication 结构
interface InterAgentCommunication {
  author: string;           // 发送方 agent 路径
  recipient: string;        // 主要接收方
  otherRecipients: string[]; // 广播目标（可选）
  content: string;          // 消息内容
  triggerTurn: boolean;     // 是否触发执行
  timestamp: string;
}

// MailboxMessage 扩展字段
interface MailboxMessage {
  // ... 现有字段
  seq: number;              // 单调递增（已有）
  triggerTurn?: boolean;    // 新增
  author?: string;          // 新增
  recipient?: string;       // 新增
}

// MailboxBlock 新增方法
class MailboxBlock {
  hasPendingTriggerTurn(): boolean;
  subscribe(): { currentSeq: number; changed: () => Promise<void>; };
  sendInterAgent(comm: InterAgentCommunication): number;
}
```

### 2.4 Fork 历史继承机制

**位置**: `src/orchestration/session-fork.ts`

```typescript
enum ForkMode {
  FullHistory = 'full',
  LastNTurns = 'last_n'
}

interface ForkOptions {
  mode: ForkMode;
  lastNTurns?: number;
}

// 过滤规则（借鉴 Codex）
function keepForkedRolloutItem(item: HistoryItem): boolean {
  switch (item.type) {
    case 'message':
      // system/user/developer: 全部保留
      // assistant: 只保留 FinalAnswer phase
      return item.role !== 'assistant' || item.phase === 'final_answer';
    case 'compacted':
    case 'event_msg':
    case 'session_meta':
      return true;
    default:
      return false;  // 丢弃 tool_call, tool_output, reasoning
  }
}
```

### 2.5 Completion Watcher

**位置**: `src/orchestration/agent-collab-watcher.ts`

```typescript
function isFinalStatus(status: AgentStatus): boolean;

class CompletionWatcher {
  constructor(
    private childId: string,
    private childPath: AgentPath,
    private parentPath: AgentPath,
    private parentMailbox: MailboxBlock
  ) {}
  
  start(): void {
    // 1. 订阅子 agent 状态
    // 2. 等待状态变为 final (completed/errored/shutdown)
    // 3. 发送 InterAgentCommunication 到父 mailbox
    // 4. trigger_turn = false（通知型）
  }
  
  stop(): void;
}
```

### 2.6 LLM 工具集

**位置**: `src/tools/internal/agent-collab-tools.ts`

| 工具名 | 作用 | 输入 | 输出 |
|--------|------|------|------|
| `agent.spawn` | 创建子 agent | `{agent_type, message, fork_mode?, model?, reasoning_effort?}` | `{agent_id, agent_path, nickname, status}` |
| `agent.wait` | 等待 mailbox 变化 | `{target, timeout_ms}` | `{timed_out, status, last_message}` |
| `agent.send_message` | 发送消息（队列） | `{target, message, interrupt?}` | `{submission_id, status}` |
| `agent.followup_task` | 发送消息（触发） | `{target, message, interrupt?}` | `{submission_id, status}` |
| `agent.close` | 关闭子 agent | `{target}` | `{previous_status}` |
| `agent.list` | 列出子 agent | `{path_prefix?}` | `{agents[]}` |

**spawn 工具详细设计**:
```typescript
interface SpawnArgs {
  agent_type?: 'explorer' | 'worker' | 'default';
  message: string;
  fork_mode?: 'full' | 'last_n';
  last_n_turns?: number;
  model?: string;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh';
  capabilities?: string[];
}

interface SpawnResult {
  agent_id: string;
  agent_path: string;    // "/root/explorer-1"
  nickname: string;      // "Darwin"
  status: 'pending_init' | 'running';
}
```

## 3. 数据流

### 3.1 Spawn → Execute → Complete

```
Project Agent (LLM)
       │
       │ 1. LLM 调用 agent.spawn
       ▼
┌──────────────────────────────────────────┐
│ agent.spawn handler                       │
│  - 检查 max_threads/max_depth             │
│  - 创建 AgentPath                         │
│  - Fork 历史继承（可选）                   │
│  - 创建子 agent module                    │
│  - 启动 Completion Watcher                │
│  - 返回 {agent_id, agent_path, nickname} │
└──────────────────────────────────────────┘
       │
       │ 2. 子 agent 执行任务
       ▼
┌──────────────────────────────────────────┐
│ Completion Watcher                        │
│  - subscribe(child_status)                │
│  - 等待 is_final(status)                  │
│  - 发送 InterAgentCommunication          │
│    到父 mailbox (trigger_turn=false)      │
└──────────────────────────────────────────┘
       │
       │ 3. 父 mailbox 收到通知
       ▼
┌──────────────────────────────────────────┐
│ Project Agent mailbox                     │
│  - 新增消息 (author=child_path)           │
│  - status=completed/errored/shutdown     │
│  - trigger_turn=false（不立即触发）       │
│  - 父 agent 通过 agent.wait 感知变化      │
└──────────────────────────────────────────┘
```

### 3.2 send_message vs followup_task

```
agent.send_message (队列式, trigger_turn=false)
  → 消息入队，不触发 turn，等待 agent 主动处理

agent.followup_task (触发式, trigger_turn=true)
  → 消息入队，立即触发 turn 执行
  → interrupt=true 可中断当前正在执行的 turn
```

## 4. 测试计划

### 4.1 单元测试

| 测试文件 | 覆盖模块 | 覆盖率目标 |
|----------|----------|------------|
| `tests/unit/common/agent-path.test.ts` | AgentPath | >= 90% |
| `tests/unit/orchestration/agent-registry.test.ts` | AgentRegistry | >= 85% |
| `tests/unit/blocks/mailbox-block/inter-agent.test.ts` | InterAgentCommunication | >= 85% |
| `tests/unit/orchestration/session-fork.test.ts` | Fork 历史继承 | >= 80% |
| `tests/unit/orchestration/agent-collab-watcher.test.ts` | CompletionWatcher | >= 80% |
| `tests/unit/tools/internal/agent-collab-tools.test.ts` | 6 个工具 | >= 80% |

### 4.2 集成测试

**位置**: `tests/orchestration/`

| 测试场景 | 验证点 |
|----------|--------|
| spawn → wait → close 生命周期 | agent 创建、执行、关闭完整流程 |
| send_message vs followup_task 行为 | trigger_turn 效果差异 |
| Completion Watcher 通知 | 子 agent 完成后父 mailbox 收到消息 |
| Fork 历史继承 | 子 agent 有正确的继承历史 |
| 并发限制触发 | spawn 超过 max_threads 返回错误 |
| 深度限制触发 | spawn 超过 max_depth 返回错误 |
| 多子 agent 并行执行 | 同时 spawn 多个 agent，各自独立执行 |
| interrupt 后 followup | interrupt=true 中断当前 turn，followup 立即执行 |

### 4.3 E2E 测试

**位置**: `tests/e2e-ui/flows/project-agent-collab.test.ts`

| 测试场景 | 验证点 |
|----------|--------|
| Project Agent spawn 多子 agent | spawn 3+ 子 agent 并行执行 |
| 子 agent 完成后自动通知 | 父 agent mailbox 有完成消息 |
| Mailbox trigger_turn 正确触发 | followup_task 触发执行，send_message 不触发 |
| 深度嵌套 spawn | 子 agent spawn 孙 agent，深度=2 |
| 大任务分解并行执行 | 复杂任务分解并行后汇总 |

## 5. 配置与部署

### 5.1 orchestration.json 新增字段

```json
{
  "collab": {
    "maxThreads": 10,
    "maxDepth": 3,
    "nicknameCandidates": {
      "explorer": ["Darwin", "Nova", "Atlas", "Orion", "Luna"],
      "worker": ["Alex", "Maya", "Leo", "Nora", "Iris"],
      "default": ["Codex", "Echo", "Flux", "Nova", "Orion"]
    },
    "forkDefaultMode": "last_n",
    "forkDefaultLastNTurns": 5,
    "waitDefaultTimeoutMs": 30000
  }
}
```

### 5.2 向后兼容

- 新增工具仅对 project 角色开放，不影响 system/reviewer
- Mailbox 扩展字段可选，现有消息格式兼容
- AgentPath 用于新创建的子 agent，现有 agent ID 不受影响
- 配置字段可选，缺失时使用默认值

## 6. 里程碑

| Phase | 任务 | 状态 |
|-------|------|------|
| Phase 1 | finger-276.1 设计文档 | 进行中 |
| Phase 2 | finger-276.2 AgentPath + finger-276.3 AgentRegistry | 待开始 |
| Phase 3 | finger-276.4 Mailbox 增强 + finger-276.5 Fork + finger-276.6 Watcher | 待开始 |
| Phase 4 | finger-276.7 LLM 工具集 | 待开始 |
| Phase 5 | finger-276.8 单元测试 | 待开始 |
| Phase 6 | finger-276.9 集成测试 | 待开始 |
| Phase 7 | finger-276.10 E2E 测试 | 待开始 |

## 7. 参考

- Codex 多 Agent 协同架构：`~/code/codex/codex-rs/core/src/tools/handlers/multi_agents_v2/`
- Codex AgentRegistry：`~/code/codex/codex-rs/core/src/agent/registry.rs`
- Codex Mailbox：`~/code/codex/codex-rs/core/src/agent/mailbox.rs`
- Codex Completion Watcher：`~/code/codex/codex-rs/core/src/agent/control.rs:888-965`
- Finger 现有架构：`docs/design/multi-agent-coordination-primitives.md`
