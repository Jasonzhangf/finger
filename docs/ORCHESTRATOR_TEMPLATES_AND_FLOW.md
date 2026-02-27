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
