# Agent Orchestration Interface V1

状态：implemented  
日期：2026-02-27

## 1. 目标

将 `chat-codex` 作为默认编排者（orchestrator），并通过标准工具调用完成：
- agent 列表与能力查询（多层暴露）
- agent 任务分配（dispatch）
- agent 控制与状态查询（control/status）
- 统一 WS 事件订阅

## 2. REST 接口

### 2.0 `POST /api/v1/message`（入口约束）

- 默认业务入口必须使用主编排目标（默认 `chat-codex-gateway`）。
- 非主编排目标直连默认拒绝（`403`, `code=DIRECT_ROUTE_DISABLED`）。
- 仅测试路径允许直连：
  - 请求头 `x-finger-route-mode: test`，或
  - `NODE_ENV=test`，或
  - sender 为 CLI。

### 2.1 `GET /api/v1/agents/catalog`

查询 agent 目录与分层能力。

Query:
- `layer`: `summary | execution | governance | full`（默认 `summary`）

Response:
- `agents[]`：每个 agent 的运行状态、实例计数、`capabilities` 分层字段
- `startupTargets[]`：已定义但尚未启动到资源池的 agent 目标
- `startupTemplates[]`：基础启动模板（默认包含 `orchestrator-loop` / `reviewer-loop` / `executor-loop`）

### 2.2 `POST /api/v1/agents/dispatch`

向目标 agent/module 派发任务。

Body:
- `sourceAgentId?: string`（默认 `chat-codex`）
- `targetAgentId: string`
- `task: unknown`
- `sessionId?: string`
- `workflowId?: string`
- `blocking?: boolean`
- `metadata?: object`

### 2.3 `POST /api/v1/agents/control`

统一控制入口。

Body:
- `action: status | pause | resume | interrupt | cancel`
- `targetAgentId?: string`
- `sessionId?: string`
- `workflowId?: string`
- `providerId?: string`
- `hard?: boolean`

### 2.4 `POST /api/v1/agents/deploy`

激活/启动 agent 到资源池（支持手动和编排器触发）。

Body:
- `targetAgentId?: string`
- `targetImplementationId?: string`
- `sessionId?: string`
- `scope?: session | global`
- `instanceCount?: number`
- `launchMode?: manual | orchestrator`
- `config?: object`

## 3. 标准工具调用

已注册运行时工具：
- `agent.list`
- `agent.capabilities`
- `agent.deploy`
- `agent.dispatch`
- `agent.control`

默认 `chat-codex` 允许工具集合包含上述五个工具，并作为默认 role profile `orchestrator`。

## 4. WS 事件

新增事件类型（`AGENT_RUNTIME` 组）：
- `agent_runtime_catalog`
- `agent_runtime_dispatch`
- `agent_runtime_control`
- `agent_runtime_status`

前端订阅需包含：
- `groups: ['AGENT_RUNTIME', ...]`
- 或显式 `types` 列表

## 5. 分层能力暴露

- `summary`: 角色、状态、来源、标签
- `execution`: 暴露工具、可分发目标、支持控制动作
- `governance`: 白名单/黑名单、授权要求、provider/session/iflow 治理信息
- `full`: 合并 execution + governance
