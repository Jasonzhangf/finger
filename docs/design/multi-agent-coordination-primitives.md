# Multi-Agent Coordination Primitives (Post-Gateway)

Status: Draft  
Last updated: 2026-04-03

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
- Phase A: correlation schema unification
- Phase B: wait/resume primitives + tests
- Phase C: status-driven coordination policy in system/project prompts
- Phase D: FLOW template + skills landing
