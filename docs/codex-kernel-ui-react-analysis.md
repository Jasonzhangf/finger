# Codex 内核、UI 交互与 ReAct 内核逻辑分析报告

## 1. 分析范围与依据

本报告聚焦三条主线：

1. Codex 内核执行链路（Rust kernel + TS bridge）
2. UI 与内核/编排层交互逻辑（HTTP + WebSocket + 前端状态聚合）
3. ReAct 内核逻辑（主链路隐式 ReAct + 兼容链路显式 ReAct）

主要依据代码：

- `rust/kernel-protocol/src/lib.rs`
- `rust/kernel-core/src/lib.rs`
- `rust/kernel-model/src/lib.rs`
- `rust/kernel-bridge-bin/src/main.rs`
- `src/agents/chat-codex/chat-codex-module.ts`
- `src/server/index.ts`
- `ui/src/api/websocket.ts`
- `ui/src/hooks/useWebSocket.ts`
- `ui/src/hooks/useWorkflowExecution.ts`
- `src/agents/runtime/execution-loop.ts`
- `src/agents/roles/executor.ts`
- `src/agents/sdk/iflow-interactive.ts`

---

## 2. Codex 内核逻辑

### 2.1 分层结构

- 协议层（`kernel-protocol`）
  - 定义 Submission/Op（`user_turn`、`interrupt`、`shutdown`、approval）
  - 定义 Event/EventMsg（`session_configured`、`task_started`、`model_round`、`tool_*`、`task_complete`）
- 运行时层（`kernel-core`）
  - 维护 submission loop 与 active task
  - 支持进行中 turn 的“二次输入注入”（不是强制新开 turn）
  - 处理 `interrupt` 与 `shutdown`
- 模型层（`kernel-model`）
  - 调用 Responses API
  - 执行工具循环（`tool_call -> tool_result/tool_error -> function_call_output 回填`）
  - 执行 context budget 估算与 compact
  - 写入 metadata（`tool_trace/round_trace/reasoning_trace/api_history/context_budget/compact`）
- 进程桥（`kernel-bridge-bin`）
  - stdin 读 Submission JSONL
  - stdout 持续写 Event JSONL
- TS 适配层（`chat-codex-module`）
  - 管理 kernel 子进程 session
  - 将 kernel event 转成 loop event
  - 在流式事件不完整时，基于 `metadata_json` 补发 synthetic tool/model 事件

### 2.2 内核执行状态机（ASCII）

```text
+--------------------+
| SessionConfigured  |
+---------+----------+
          |
          | Op::UserTurn
          v
+---------+----------+
| TaskStarted        |
+---------+----------+
          |
          | run_turn + progress events
          v
+---------+-------------------+
| TurnRunning                 |
| (model_round / tool events) |
+----+-------------------+----+
     |                   |
     | Op::Interrupt     | Op::UserTurn (while running)
     v                   v
+----+-----------+   +---+----------------------+
| TurnAborted    |   | PendingInputInjected     |
| user_interrupt |   | (same active task queue) |
+----+-----------+   +---+----------------------+
     |                   |
     +---------+---------+
               |
               v
        +------+------+
        | TaskComplete|
        +------+------+
               |
               | Op::Shutdown
               v
        +------+---------+
        | ShutdownComplete|
        +----------------+
```

关键点：

- active turn 存在时，新的 `UserTurn` 会注入同一 task 的输入通道。
- `interrupt` 触发 `TurnAborted(user_interrupt)`。
- `shutdown` 会终止 task 并发 `ShutdownComplete`。

### 2.3 模型与工具循环

`ResponsesChatEngine.complete_with_options()` 的主循环可抽象为：

1. 组装 `rolling_input`（system/developer/user/history/context ledger focus）
2. 请求 Responses API
3. 解析 `output_text`、`function_calls`、`reasoning`、`history_items`
4. 发出 `model_round` 进度事件（含 token/context 指标）
5. 若有 function calls：
   - 发 `tool_call`
   - 调用 `/api/v1/tools/execute`
   - 发 `tool_result` 或 `tool_error`
   - 将结果封装为 `function_call_output` 回填下一轮
6. 无工具调用且有有效输出文本则结束；超轮次（64）报错

补充机制：

- `context_ledger.memory` 工具调用会注入 `_runtime_context`。
- `shell.exec` 参数会做标准化。
- compact 支持手动与阈值触发自动模式，compact 信息写入 metadata 与 ledger。

---

## 3. UI 交互逻辑

### 3.1 交互通道

- HTTP
  - `POST /api/v1/message`：核心消息入口（支持 blocking/non-blocking）
  - `POST /api/v1/finger-general/sessions/:sessionId/interrupt`：中断当前 turn
  - `POST /api/v1/workflow/pause` / `resume`：流程控制
- WebSocket（默认 `:5522`）
  - 客户端连接后发送 `subscribe`
  - 订阅 `chat_codex_turn`、`tool_*`、`workflow_update`、`phase_transition`、`input_lock_*` 等

### 3.2 服务端事件桥

- `chat-codex-module` 输出 `onLoopEvent`
- `server/index.ts` 中 `emitLoopEventToEventBus()` 广播 WS `chat_codex_turn`
- 同时，服务端会将 EventBus 的任务/阶段事件转成 `workflow_update` 与 `agent_update`

关键补偿逻辑：

- 当实时流缺失细粒度 `tool_*`/`model_round` 时，`chat-codex-module` 从 `task_complete.metadata_json` 反解 `tool_trace/round_trace`，补发 synthetic 事件，保证 UI 可恢复轨迹。

### 3.3 前端状态聚合核心

`useWorkflowExecution` 是 UI 侧执行态主聚合器：

- 消费 `chat_codex_turn`：
  - `turn_start` -> running
  - `kernel_event.task_started` -> 更新上下文窗口
  - `kernel_event.model_round` -> 更新轮次文本、token、上下文占用
  - `kernel_event.pending_input_queued` -> 标记“输入排队”
  - `turn_complete` / `turn_error` -> 结束或错误
- 消费 `tool_call/tool_result/tool_error`：更新 agent run status 与工具面板信息
- 消费 `phase_transition/workflow_update/agent_update`：映射编排阶段到 UI 状态
- 消费 `input_lock_changed/input_lock_heartbeat_ack/typing_indicator`：维持多端输入互斥与输入中状态

### 3.4 UI 运行状态机（ASCII）

```text
+-------+
| Idle  |
+---+---+
    |
    | startWorkflow/sendUserInput
    v
+---+-----------+
| TurnStarting  |
+---+-----------+
    |
    | chat_codex_turn.turn_start/task_started
    v
+---+----------------------+
| TurnRunning              |
+---+-----------+----------+
    |           |
    |           | chat_codex_turn.pending_input_queued
    |           v
    |      +----+---------+
    |      | InputQueued  |
    |      +----+---------+
    |           |
    |           | wait current turn merge
    |           v
    |      +----+---------+
    +----->| TurnRunning  |
           +----+---------+
                |
                | tool_call/tool_result/tool_error
                v
           +----+---------+
           | Tooling       |
           +----+---------+
                |
                v
           +----+---------+
           | TurnComplete |
           +----+---------+
                |
                v
               Idle

(any) -- turn_error --> Error
(any) -- interrupt  --> Interrupted -> Idle
```

---

## 4. ReAct 内核逻辑

### 4.1 主链路：隐式 ReAct（事件化）

主链路并不强制输出自然语言的 "Thought/Action/Observation" 字段，但语义闭环完整：

- Thought：`model_round` + `reasoning_trace`
- Action：`tool_call`（函数调用）
- Observation：`tool_result/tool_error` + `function_call_output` 回填

这是“结构化事件 ReAct”，不是“文本模板 ReAct”。

### 4.2 兼容链路：显式 ReAct（iFlow/legacy）

仓库仍存在显式 ReAct 编排路径：

- `ExecutorRole`：显式状态 `thinking -> acting -> observing`
- `IflowInteractiveAgent.interact()`：按 message type 循环处理（assistant/tool_call/permission/task_finish）
- `ExecutionLoop.run()`：orchestrator 拆解、派发、收集反馈、失败重规划

这条链路更接近传统多 agent ReAct，并与主链路并存。

### 4.3 ReAct 抽象状态机（ASCII）

```text
+---------+
| Thought |
+----+----+
     |
     | decide next action/tool
     v
+----+----+
| Action  |
+----+----+
     |
     | execute tool / subtask
     v
+----+--------+
| Observation |
+----+--------+
     |
     | enough evidence?
     +---- no ----------------------+
     |                              |
     +----------- yes --------------+
                 |
                 v
            +----+----+
            | Complete |
            +---------+

(any) -- interrupt/error --> Aborted/Failed
```

---

## 5. 关键结论

1. 当前主链路已经形成闭环：`kernel-model` 工具循环 -> `chat-codex-module` 事件桥 -> `server` WS 广播 -> `useWorkflowExecution` 状态聚合。  
2. UI 不只是日志展示，而是“执行态协调器”：同时整合 turn、tool、phase、token budget、input lock。  
3. ReAct 在主链路中是隐式事件化实现，在 legacy 路径中是显式阶段实现；双栈保证兼容性，但也带来维护认知成本。  
4. `metadata_json` + synthetic event 回放是可观测性关键能力，可在流式事件不完整时维持 UI 执行轨迹一致性。

## 6. 建议关注点

- 若后续做架构收敛，建议优先统一 ReAct 表达层（统一为事件协议或统一为显式阶段），避免双语义栈长期并存。  
- 建议将 `pending_input_queued`、`turn_retry`、`context_compact` 进一步标准化为统一前端协议字段，降低 UI 侧兼容分支复杂度。  
- 建议补充“流式丢包 + metadata 回放”端到端测试，持续验证 synthetic 事件恢复链路。
