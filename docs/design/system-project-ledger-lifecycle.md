# System ↔ Project Ledger 生命周期设计（Session / Mailbox / Dispatch）

> Last updated: 2026-03-24 16:05 +08:00  
> Status: Approved（设计真源）  
> Owner: Jason

---

## 1. 目标与范围

本文定义以下闭环的唯一行为规范：

1. System Agent 与 Project Agent 各自如何维护自己的 session / ledger；
2. System 派发任务给 Project 后，Project 如何在自己的上下文持续推理；
3. Project 通过 mailbox / report-task-completion 回传结果时，System 如何写入自己的流水历史；
4. 避免“会话漂移导致遗忘/重复执行”的约束与修复策略。

本文是 `docs/design/ledger-session-integration.md` 的场景化补充，聚焦 **System↔Project 双 Agent 生命周期**。

---

## 2. 核心原则（必须遵守）

### 2.1 Session 分工：各自维护、相互关联

- **System Agent 维护 system session（root 会话）**；
- **Project Agent 维护 project runtime child session（子会话）**；
- 二者不是同一个 session，但通过 `parentSessionId/rootSessionId` 关联到同一 root 树。

### 2.2 Ledger 分工：各写各账，不互相覆盖

- System 账本写编排流水（用户输入、派发状态、回传摘要、通知）；
- Project 账本写执行流水（任务上下文、工具链路、推理、结果形成过程）；
- 禁止“Project 执行细节覆盖/替代 System 编排流水”。

### 2.3 回传闭环：回报可走 mailbox，但 System 必须有可追溯摘要

- Dispatch 终态（completed/failed）必须最终在 System session 可见；
- mailbox 仅是传输/缓冲机制，不是唯一事实展示面；
- 回传必须带关联键（`dispatchId` / `sessionId` / `mailboxMessageId`）。

### 2.4 防漂移约束

- 禁止把 `msg-*` 这类消息 ID 当 sessionId 使用；
- 回传到 System 前必须解析到稳定 root session；
- 默认复用已有 session（`latest/current`），不无故 `new`。

---

## 3. 角色与数据所有权

### 3.1 System Agent Ledger（编排视角）

System ledger 记录：

1. 用户输入（直达 System 的 user message）；
2. 派发动作与状态推进（queued/processing/completed/failed）；
3. 子任务结果摘要（summary / error / key files）；
4. 子会话指针（`child:<sessionId>`）；
5. mailbox 相关通知（队列转邮箱、ACK 完成等）。

> 目标：让 System 视角可单独重放“派发了什么、谁处理了、结果如何”。

### 3.2 Project Agent Ledger（执行视角）

Project ledger 记录：

1. System 派发任务文本（含 dispatch contract / goal）；
2. 执行过程（tool_call / tool_result / tool_error / reasoning / model_round）；
3. 结果组织与上报动作（含 report-task-completion / mailbox.ack）。

> 目标：完整保留执行证据，支持复盘与精细诊断。

---

## 4. 生命周期时序（标准流程）

### 4.1 用户输入进入 System

1. 外部通道（如 QQ）消息进入 ChannelBridge；
2. 用户输入直达 System Agent（非“用户消息再派发给 system”模式）；
3. 写入 System session ledger（user + 接收确认信息）。

---

### 4.2 System 派发给 Project

1. System 调用 `agent.dispatch`；
2. runtime 选择 session（默认 `latest`，可 `current/new`）；
3. 若目标非 system，自 root session 绑定/复用目标 agent 的 runtime child session；
4. 派发事件写入：
   - Project 子会话：收到任务与执行上下文；
   - System 会话：写“派发状态摘要”。

若目标忙：

- 触发 queue timeout fallback → 写入目标 mailbox；
- System 会话写 `状态=邮箱等待 ACK` + `mailboxMessageId`。

---

### 4.3 Project 执行并回传

Project 有两种回传路径：

### A. 常规 dispatch 直接返回

- Dispatch 完成后触发 `agent_runtime_dispatch(completed|failed)`；
- `event-forwarding` 在 System session 写入：
  - 派发状态摘要（system 消息）
  - 最终结果摘要（assistant 消息）
  - child session pointer（可选）
  - dispatch-result mailbox 通知（供上层消费）

### B. mailbox + ack 返回（离线/异步）

1. Project `mailbox.read`/`read_all` 领取任务（状态变 processing）；
2. 执行完成后 `mailbox.ack(id, { summary/result 或 error })`；
3. ack 触发 `agent_runtime_dispatch` 终态事件（completed/failed）；
4. `event-forwarding` 将终态摘要写回 System session。

---

## 5. “每次 dispatch 摘要”写入内容规范

System session 中每个 dispatch 至少应出现两类记录：

### 5.1 派发状态摘要（system 消息）

建议字段（展示可拼接为一行）：

- `dispatchId`
- `sourceAgentId`
- `targetAgentId`
- `status`（queued / processing / completed / failed / queued_mailbox）
- `queuePosition`（可选）
- `mailboxMessageId`（可选）
- `taskId` / `bdTaskId`（可选）

### 5.2 终态结果摘要（assistant 消息）

建议字段：

- `dispatchId`
- `status`（completed / failed）
- `summary`（必填，最短可读结论）
- `error`（失败时必填）
- `keyFiles`（可选）
- `childSessionId`（可选）
- `via=mailbox` / `mailboxMessageId`（若从 mailbox 回传）

---

## 6. mailbox 语义与生命周期

### 6.1 mailbox 是“收件人侧时效管理”

- 发送方不负责“消息读后即删”；
- 清理由收件方或定时策略驱动；
- 完成类消息允许短时保留，避免丢状态。

### 6.2 ack 规则

- 任务真正完成才 `mailbox.ack`；
- 失败必须显式 `status=failed` + `error`；
- ack 成功后消息自动清理（实现层 remove）。

### 6.3 读信策略（agent 行为）

- mailbox 列表可先看 title/shortDescription；
- 明显不需处理的消息可直接 ack/remove；
- 必要时再 read 详情，避免 token 浪费。

---

## 7. 会话映射与防遗忘修复（2026-03-24）

### 7.1 已修复问题

历史问题：回报链路中出现 `sessionId=msg-*`，导致结果写入错误会话，表现为“上下文像被清空、重复执行”。

修复策略（`fix(dispatch): stabilize task-report session routing`）：

1. report 回传前先把 session 解析到 root（若传入 runtime child/异常 ID）；
2. 优先级：requested → runtime current → sessionManager current → system fallback；
3. 若替换了 session，写入 `originalSessionId` 供审计。

### 7.2 结果保证

- System 汇总流水写回稳定会话；
- Project 执行流水保持在自身会话；
- 两边都可追溯，不再因为 session 漂移丢失链路。

---

## 8. 实现映射（关键模块）

- Dispatch 会话选择与绑定：`src/server/modules/agent-runtime/dispatch.ts`
- mailbox read/ack 与事件回发：`src/server/modules/agent-runtime/mailbox.ts`
- mailbox dispatch 事件组装：`src/server/modules/agent-runtime/mailbox-shared.ts`
- 派发事件写入 System session：`src/server/modules/event-forwarding.ts`
- task report 回传会话归一：`src/agents/finger-system-agent/task-report-dispatcher.ts`

---

## 9. 验收清单（用于联调/回归）

1. 同一任务在 System session 可见：
   - 派发摘要（queued/processing）
   - 终态摘要（completed/failed）
2. Project session 持续追加，不因多轮对话重置；
3. 日志中不再出现回传 `sessionId=msg-*`；
4. mailbox ack 后对应任务消息清理，且 System 侧已落终态摘要；
5. 重启后从 ledger 重建，System/Project 双侧历史均可恢复。
