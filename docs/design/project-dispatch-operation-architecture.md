# 项目派发与 Operation 架构设计

## 1. 背景与现状评估

### 1.1 当前问题

| 问题 | 根因 | 后果 |
|------|------|------|
| 任务派发 = 发消息 | dispatch 本质是往 chat session 塞消息 | Agent 忙时变 `pending_input_queued`，越积越多 |
| Agent 未启动时丢任务 | 消息只在内存 | 重启后任务丢失，无法恢复 |
| 状态盲人摸象 | System Agent 无法直接获知 Agent 状态 | 只能猜或问，频繁误判 busy/idle |
| 数据真源分裂 | 任务分散在 update_plan / projectTaskState / BD 三处 | 重启后对不齐，重复执行或丢失 |
| Chat 与任务耦合 | 沟通和任务共用一个通道 | 互相阻塞，pending_input 风暴 |

### 1.2 核心设计缺陷

当前架构把 **"项目管理"** 和 **"消息通信"** 混为一谈：
- 发一条消息 = 派一个任务
- Agent 忙 = 新任务排队等（甚至丢）
- 查进度 = 问 Agent

**正确做法**：两条线彻底解耦。

---

## 2. 新架构核心原则

- **任务管理**：Operation（指令）驱动 + BD（持久化真源）
- **状态可见**：Registry（状态中心）实时同步，直接读，不用问
- **沟通交互**：Chat（消息通道），用于询问和调试，不改变任务状态

---

## 3. 架构组件

### 3.1 BD — 任务持久化真源

| 存储 | 路径 | 写入权限 |
|------|------|----------|
| System BD | `~/.finger/beads/issues.jsonl` | 仅 System Agent 读写 |
| Project BD | `<project_path>/.beads/issues.jsonl` | System Agent + Project Agent 均可写 |

**写入权限与路径细节：**
- **System Agent** 通过 `Op.epic.assign` 写入 Project BD（设置 assignee）。
- **Project Agent** 通过 `Op.epic.claim` / `start` 写入自己的 Project BD（认领、启动）。
- **规则**：BD 是唯一真源，谁对 Project 负责谁就有写权限，以最后写入的状态为准。

**BD Epic 新增字段：**

```typescript
interface BDEpic {
  id: string;
  title: string;
  status: 'open' | 'claimed' | 'in_progress' | 'done' | 'closed' | 'blocked';
  priority: number;           // 0 最高，默认 5
  assignee?: string;          // 认领该任务的 Agent/Worker ID
  boundSessionId?: string;    // 执行该任务的 Session ID
  blockedBy?: string[];       // 阻塞依赖
  periodicKey?: string;       // 周期任务唯一键（如 hb:project:jobName）
  parentEpicId?: string;      // 所属大 epic
  createdAt: number;
  updatedAt: number;
}
```

**关键语义：**
- `assign`：只是改归属权（`assignee` 字段），不改变 Agent 当前执行状态
- `claim`：Agent 自己认领（`assignee = self`，`status = claimed`）
- `start`：开始执行（`status = in_progress`，`boundSessionId` 绑定）

### 3.2 Operation Block — 指令通道

替代旧的"发消息"机制。

```typescript
enum OpType {
  // 任务控制
  'epic.create'    = 'epic.create',    // 创建新 epic
  'epic.assign'    = 'epic.assign',    // 指派 assignee（不改 current）
  'epic.claim'     = 'epic.claim',     // agent 认领任务
  'epic.start'     = 'epic.start',     // 开始执行（设为 current）
  'epic.stop'      = 'epic.stop',      // 停止执行
  'epic.resume'    = 'epic.resume',    // 恢复执行
  'epic.update'    = 'epic.update',    // 修改 epic 内容
  'epic.priority'  = 'epic.priority',  // 调整优先级
  'epic.close'     = 'epic.close',     // 关闭 epic

  // 紧急抢占
  'agent.preempt'  = 'agent.preempt',  // 停止当前任务，切换到新任务

  // 状态查询
  'agent.status'   = 'agent.status',   // 查询 agent 状态
  'project.list'   = 'project.list',   // 查询 project epic 列表
  'team.status'    = 'team.status',    // 查询 team 状态

  // 交互（走 Chat 通道，不阻塞任务）
  'agent.query'    = 'agent.query',    // 发送问题给 agent
}

interface Operation {
  opId: string;
  type: OpType;
  sourceAgentId: string;
  targetAgentId: string;
  projectPath?: string;
  epicId?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}
```

**Operation 特性：**
- **包装现有模块**：Operation Block 是对 `AgentRuntimeBlock` 的包装。它负责指令的路由、持久化和控制逻辑，底层执行依然调用 `AgentRuntimeBlock`（如启动/停止 kernel）。
- **渐进式替换**：旧的 `dispatchTaskToAgent` 接口保留但标记为 `@deprecated`。新的业务逻辑优先使用 Operation Block。
- **持久化**：写入 `~/.finger/runtime/operation-log.jsonl`，不丢失
- **幂等**：每个 opId 唯一，重复发送不重复执行
- **不经过 Chat 队列**：独立路由，不干扰 pending_input

### 3.3 Team Registry — 状态中心

所有 Agent 实时可见的状态视图：

```typescript
interface AgentMemberState {
  agentId: string;
  workerId?: string;
  status: 'idle' | 'ready' | 'busy' | 'offline';
  currentEpicId?: string;        // 正在执行的任务
  ownedTaskCount: number;        // 已认领未完成的任务数
  health: 'healthy' | 'degraded' | 'unhealthy';
  projectPath?: string;
  lastStatusUpdateAt: number;
}

interface AgentTeamRegistry {
  members: AgentMemberState[];
  lastRefreshedAt: number;
}
```

**传输层：**
- **复用现有 `EventBus`**。
- Agent 状态变化时发布 `agent_status_update` 事件。
- Registry 订阅该事件，实时更新内存中的 Team 状态视图。
- **优势**：不引入新依赖，利用已有的可靠消息总线。

**状态更新机制：**
- Agent 状态变化 -> 发 Event `agent_status_update` -> Registry 订阅同步
- System Agent 读 Registry 即知全貌，无需"问"

---

## 4. 核心流程

### 4.1 派发 vs 执行（关键区分）

| 操作 | 对 BD 的影响 | 对 Agent 状态的影响 |
|------|-------------|-------------------|
| **System: Assign** | `assignee = AgentID` | **无**（Busy 继续，任务入待办池） |
| **System: Preempt** | 旧任务暂停 + 新任务 `assignee` 更新 | **Stop Current -> Start New** |
| **Agent: Claim** | `assignee = self`, `status = claimed` | 无（只是认领，不一定立刻做） |
| **Agent: Start** | `status = in_progress`, `boundSessionId` | **Idle -> Busy** |
| **Agent: Finish** | `status = done` | **Busy -> Idle**（自动查待办池） |
| **Agent: Pick Next** | 下一个 `status = in_progress` | **Idle -> Busy** |

### 4.2 场景一：System Agent 派发任务（Normal Dispatch）

```
System Agent                          Project Agent
    |                                      |
    | 1. 读 Registry，发现 Alex idle       |
    | 2. BD: create epic "288.1"           |
    | 3. Op.epic.assign {288.1, Alex}  --> |
    |                                      | 4. 收到 Operation
    |                                      | 5. BD: claim {288.1}
    |                                      | 6. BD: start {288.1}
    |                                      | 7. 启动 Kernel 推理
    |                                      | 8. Event: status=busy, current=288.1
    | 9. Registry 更新（看到 Alex busy）    |
```

**关键**：如果 Alex 已经 busy：
- Step 3 仍然成功，只是 assignee 写入 BD
- Alex 收到 Operation 但不切换 current（继续忙手头的）
- 新任务进入 Alex 的待办池
- Alex 完成当前任务后自动 pickup 下一个

### 4.3 场景二：System Agent 紧急抢占

```
System Agent                          Project Agent
    |                                      |
    | 1. Op.agent.preempt {                |
    |      stop: "288.1",                  |
    |      start: "289.0"                  |
    |    }                            --> |
    |                                      | 2. 停止当前 Kernel
    |                                      | 3. BD: 288.1 -> paused
    |                                      | 4. BD: claim+start 289.0
    |                                      | 5. 启动新 Kernel
    |                                      | 6. Event: status=busy, current=289.0
```

### 4.4 场景三：Project Agent 自治（做完自动拿下一个）

```
Project Agent
    |
    | 1. 完成 current epic -> BD: done
    | 2. Event: status=idle
    | 3. 查 BD: owned tasks (assignee=self, status=claimed/open)
    | 4. 按 priority 排序，取最高
    | 5. BD: start {nextEpicId}
    | 6. 启动 Kernel
    | 7. Event: status=busy, current=nextEpicId
```

### 4.5 场景四：重启恢复

```
Project Agent (重启)
    |
    | 1. 读 BD: 找 assignee=self 且 status=in_progress 的 epic
    | 2. 如果有 -> 自动恢复执行
    | 3. 如果没有 -> 查 claimed/open -> pickup
    | 4. Event: status=busy/idle
```

### 4.6 场景五：异步询问进度（不阻塞任务）

```
System Agent                          Project Agent
    |                                      |
    | Op.agent.query {                     |
    |   question: "288.1 做到哪了？"       |
    | }                              -->   |
    |                                      | 收到 Query（走 Chat 通道）
    |                                      | 异步回复（不影响当前任务）
    | <-- 回复：summary of 288.1 progress  |
```

---

## 5. System Agent 的上下文视图

System Agent 的 session context 需要注入以下信息：

### 5.1 自身 Epic 列表
- 来自 `~/.finger/beads/issues.jsonl`
- 显示当前 system 级别的 epic 及状态

### 5.2 派发到各 Project 的 Active 任务
- 跨 project 聚合：每个 project 的 active epic 列表
- 包含 assignee、status、priority

### 5.3 Team 状态面板
- 所有 member 的 status/idle/busy + current task
- 用于智能派发决策

### 5.4 Project Epic 详情查询
- 按 projectPath 获取该 project 的完整 epic 列表
- 包含所有 assignee 分布

---

## 6. Project Agent 的任务池模型

```
┌─────────────────────────────────────────────┐
│           Project Agent 任务池               │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Epic A   │  │ Epic B   │  │ Epic C   │  │
│  │ in_prog  │  │ claimed  │  │ open     │  │
│  │ (current)│  │ (queued) │  │ (queued) │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│                                             │
│  Current = A (Kernel 正在跑)                 │
│  Queued = [B, C] (按 priority 排序)         │
│  A 完成 -> 自动 pickup B                     │
└─────────────────────────────────────────────┘
```

**选择规则：**
- 按 `priority` 升序（0 最高）
- 同 priority 按 `updatedAt` 降序（最新优先）
- `blocked` 状态跳过

---

## 7. 周期任务语义

- 周期任务不常驻，每次触发临时入队
- **替换规则**：如果同 `periodicKey` 的上次任务未完成，标记 `replaced`，创建新任务
- 完成后从 active 视图移除，不堆积

---

## 8. 实施步骤与关键里程碑

### Phase 1: Operation Block + BD 扩展 (P0 - 止血恢复)
- **目标**：实现**重启自动恢复**能力。
- **交付物**：
  1. BD Epic 增加 `assignee`, `boundSessionId` 字段。
  2. `Operation Block` 核心逻辑（持久化、路由、Op 类型定义）。
  3. Project Agent 启动时读取 BD 中属于自己的 `in_progress` 任务并自动恢复。
- **效果**：重启后，只要 BD 中有记录，Agent 就能自动找回任务继续做。不再需要依赖内存中的 pending_input。

### Phase 2: Team Registry 改造 (状态可见性)
- 改造 `AgentRegistry` 增加 team 状态视图。
- 实现 status event 监听 + 实时同步 (基于 EventBus)。
- System Agent 注入 Team Status 到上下文。

### Phase 3: Project Agent 改造 (去消息化)
- 新增 Operation Listener（不依赖 chat pending_input）。
- 实现 epic.claim/start/pick-next 流程。
- 状态更新 -> event 发出。

### Phase 4: System Agent 改造 (智能派发)
- 替换 dispatch 为 operation-based (`Op.epic.assign` + `Op.epic.preempt`)。
- 实现按 Registry 状态（Idle/Busy）智能选择 Agent。

### Phase 5: 替换旧 dispatch (清理)
- 废弃 `dispatchTaskToAgent` 消息模式。
- 清理 `pending_input_queued` 相关逻辑。
- 统一入口：Task -> Operation, Chat -> Message。

---

## 9. 验收标准

1. System Agent 创建 epic + assign -> Project Agent 自动 claim 并执行（无需 chat 消息）
2. System Agent 读 Registry 即知所有 agent 状态（无需问）
3. Project Agent 重启 -> 从 BD 恢复 epic -> 继续执行（无消息丢失）
4. 同一 project 多 agent 共享 epic 列表，看到不同 assignee
5. Agent busy 时新 assign 只是入待办池，不干扰 current
6. `Op.agent.preempt` -> Agent 立即停止当前，切换新任务
7. Chat 消息不阻塞任务执行
8. 周期任务：同 key 未完成时替换，完成后自动清理
