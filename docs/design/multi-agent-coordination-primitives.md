# Multi-Agent Coordination Primitives (Post-Gateway)

Status: Superseded by finger-276 for Project Agent internal collab  
Last updated: 2026-04-06

> **NOTE**: 本文档的 Phase A/B 保持不变。Phase C/D 的 agent-to-agent 协同能力已由 **finger-276** (Project Agent 内部多 Agent 协同增强) 覆盖，详见 `docs/design/project-agent-internal-collab-design.md`。

## Scope
After ProjectStatusGateway is unified, add baseline coordination primitives for multi-agent teamwork:
- cross-agent notify/query/ask progress
- async wait/resume with correlation
- status-driven resume (snapshot-first)

## Goals
1. Standardize correlation fields across query/dispatch/mailbox (`request_id`, `taskId`, `dispatchId`).
2. Ensure query/ask results can update task status without interrupting active execution.
3. Add deterministic wait/resume contract for cross-agent collaboration.
4. Ensure system can continue reasoning immediately after receiving coordination replies.

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
