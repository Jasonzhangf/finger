# Multi-Agent Coordination Primitives (Post-Gateway V3)

> **Status**: Superseded by finger-276 for Project Agent internal collab
> **Last updated**: 2026-04-07 (V3)
> **V3 Changes**: Reviewer Agent removed, System Agent now handles review

## Scope

After ProjectStatusGateway is unified, add baseline coordination primitives for multi-agent teamwork:

- System ↔ Project coordination (dispatch/claim/review/approve)
- Project Agent internal collab (covered by finger-276)
- async wait/resume with correlation
- status-driven resume (snapshot-first)

## Goals

1. Standardize correlation fields across query/dispatch/mailbox (`request_id`, `taskId`, `dispatchId`).
2. Ensure query/ask results can update task status without interrupting active execution.
3. Add deterministic wait/resume contract for cross-agent collaboration.
4. Ensure system can continue reasoning immediately after receiving coordination replies.

## V3 Architecture (2-Agent Model)

**System Agent ↔ Project Agent coordination primitives**:

| Primitive | Owner | Description |
|-----------|-------|-------------|
| `agent.dispatch` | System → Project | Dispatch task with taskId |
| `project.claim_completion` | Project → System | Submit structured claim with evidence |
| `project.review_claim` | System (self) | Audit claim, PASS/REJECT decision |
| `project.approve_task` | System | Mark task approved, report to user |
| `project.reject_task` | System | Reject claim, feedback for rework |

**Note**: Reviewer Agent is removed in V3. System Agent handles review responsibility.

## Phases

- Phase A: correlation schema unification ✅ (finger-274)
- Phase B: wait/resume primitives + tests ✅ (finger-274.2)
- Phase C: ~~status-driven coordination policy~~ → **已迁移至 finger-276** (LLM 工具驱动: agent.spawn/wait/send/close/list)
- Phase D: ~~FLOW template + skills landing~~ → **已迁移至 finger-276** (Project Agent 内部 Collab Tools)

### finger-276 范围（替代 Phase C/D）

finger-276 为 Project Agent 内部提供 Codex 风格的 LLM 工具驱动多 agent 协同：

- `agent.spawn` / `agent.wait` / `agent.send_message` / `agent.followup_task` / `agent.close` / `agent.list`
- AgentPath 层级路径系统
- Mailbox InterAgentCommunication + trigger_turn
- Completion Watcher 自动通知
- Fork 历史继承
- AgentRegistry 并发控制（max_threads / max_depth）

详见: `docs/design/project-agent-internal-collab-design.md`

## References

- Canonical lifecycle: `docs/design/project-task-lifecycle-state-machine.md`
- System Agent design: `docs/design/system-agent-v2-design.md`
- Project Agent internal collab: `docs/design/project-agent-internal-collab-design.md`
