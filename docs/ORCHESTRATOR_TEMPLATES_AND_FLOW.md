# Orchestrator Templates And Default Flow

## 4 Core Loop Templates

- `epic_planning`: Build or update epic decomposition, dependencies, and assignment strategy.
- `parallel_execution`: Dispatch independent non-blocking tasks to different agents in isolated contexts.
- `review_retry`: Route execution output through reviewer and decide retry/pass.
- `search_evidence`: Run retrieval-first evidence collection and source validation.

## Template Suggestion Tool

- Tool name: `orchestrator.loop_templates`
- Purpose: classify tasks into loop templates and split blocking/non-blocking work.
- Output includes:
  - `primaryTemplate`
  - `taskSuggestions`
  - `blockingTaskIds`
  - `nonBlockingTaskIds`

## Default Assignment Flow

1. `orchestrator -> reviewer -> assignee` for epic plan admission.
2. `assignee -> reviewer -> retry|pass` for execution result gating.
3. On assignee completion, execution result is fed back to orchestrator as structured follow-up input.

## Dispatch Lifecycle Metadata

The dispatch envelope may include:

- `epicId`
- `taskId`
- `bdTaskId`
- `assignerAgentId`
- `assigneeAgentId`
- `phase` (`assigned|queued|started|reviewing|retry|passed|failed|closed`)
- `attempt`

These fields are emitted with `agent_runtime_dispatch` events and forwarded in task metadata.

## Queue Behavior

- If target capacity is exhausted, dispatch enters per-agent queue.
- Queue drains automatically when running dispatch completes.
- Blocking self-dispatch under exhausted capacity is rejected to avoid deadlock.
- Queue timeout marks dispatch as failed.

## Ask Scope

- `user.ask` is scoped to the requesting `agentId`.
- Answering one pending ask only resumes that agent's request and does not consume asks from other agents.

## UI Debug Snapshot Contract

- Scope: UI session page (`ChatInterface`) debug mode only.
- Toggle: per-session local switch (`Debug Snapshots`), default off.
- Snapshot granularity: one request can produce multiple stage snapshots.

### Snapshot Stages

- `request_build`: request body and route prepared.
- `request_attempt`: each retry attempt before `/api/v1/message`.
- `request_ok`: successful response with status/result metadata.
- `request_error`: failed attempt with status/error.
- `chat_codex_turn`: websocket turn events (`turn_start/kernel_event/turn_complete/turn_error`).
- `phase_transition`: websocket phase transition (`from -> to`).
- `tool_call` / `tool_result` / `tool_error`: websocket tool execution stages.

### Snapshot Payload (minimal stable fields)

- `id`
- `timestamp`
- `sessionId`
- `stage`
- `summary`
- optional: `requestId`, `attempt`, `phase`, `payload`

## Runtime Mode Visibility

- API: `GET /api/v1/orchestrator/runtime-mode`
- Purpose: expose active orchestrator loop path to UI/debug.
- Initial truth source in current implementation:
  - `mode = finger-general-runner` (runtime wired to `finger-orchestrator`).
  - `fsmV2Implemented = true` if `orchestrator-fsm-v2` exists but not active.
- UI should show this as non-blocking status text, not as hard gate.
