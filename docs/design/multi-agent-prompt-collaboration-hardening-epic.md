# Multi-Agent Prompt & Collaboration Hardening (Epic Plan)

> Status: **Execution Plan (Authoritative for this epic)**  
> Date: 2026-04-01  
> Related canonical lifecycle spec: `docs/design/project-task-lifecycle-state-machine.md`  
> Reference baseline: `~/code/claude-code` coordinator/worker design patterns (adapted, not copied)

---

## 1. Objective

Close the current multi-agent reliability gaps by hardening:

1. prompt contracts (System / Project / Reviewer),
2. runtime guardrails (state-machine + permission + session binding),
3. structured cross-agent result protocol,
4. resume/continue semantics (avoid repeated re-dispatch).

Target outcome:
- System agent plans/dispatches/monitors and does not re-implement delegated in-flight project tasks.
- Project agent executes and produces evidence.
- Reviewer only validates and returns PASS/REJECT.
- Restart/heartbeat resumes from bound task/session without duplicate execution.

---

## 2. Design Inputs (Claude-inspired, Finger-adapted)

From `claude-code` we adopt these ideas:

1. Coordinator role separation: orchestrator should coordinate, not duplicate worker execution.
2. Structured worker notification contract: completion should not depend on free-form prose parsing.
3. Continue existing worker/session when context overlap is high; avoid spawning duplicate lanes.
4. Explicit concurrency discipline: parallel read/research, serialized write on overlapping scope.

Finger-specific adaptations:
- Keep existing `project.task.status` / `project.task.update` tools as primary pre-dispatch/update gates.
- Enforce existing System↔Project↔Reviewer lifecycle and reject-path routing already defined in canonical spec.
- Keep ledger control/reasoning lane separation and heartbeat no-noise policy.

---

## 3. Prompt Hardening Plan

## 3.1 System Agent prompt changes

Mandatory behavior (front-loaded):

1. Requirement clarification + execution contract confirmation before first project dispatch.
2. Pre-dispatch gate: must call `project.task.status` before any new dispatch.
3. If task is `dispatched|in_progress|waiting_review`:
   - do not dispatch duplicate task,
   - do not implement same task in system lane,
   - only monitor or `project.task.update` when user explicitly requests requirement changes.
4. After dispatch, enter monitor mode until review PASS/REJECT or user-requested update.
5. No out-of-scope execution: suggestions require user approval first.

## 3.2 Project Agent prompt changes

1. Executor-only responsibility for delegated task.
2. Stable task identity (`taskId/taskName`) across all updates/retries.
3. Report completion only with clean delivery claim:
   - summary,
   - changed files,
   - verification evidence,
   - acceptance checklist status.
4. On review reject: continue rework under same task identity.

## 3.3 Reviewer prompt changes

1. Validator-only role.
2. Must output explicit PASS/REJECT with evidence.
3. Must not dispatch implementation work to any other agent.
4. If claim lacks evidence, reject as incomplete claim with required evidence checklist.

---

## 4. Runtime Hardening Plan

## 4.1 Structured cross-agent report contract

Replace text-only completion propagation with structured payload schema:

- `task_id`, `task_name`, `revision`
- `status` (`success|failure|incomplete_claim`)
- `evidence` (artifacts/files/tests)
- `next_action` (`pass_to_system|rework_to_project`)
- `usage` (optional telemetry)

## 4.2 Continue-vs-dispatch separation

Introduce explicit continuation path for in-flight task/session:

- `agent.dispatch`: new assignment lane
- `project.task.update`: user-approved requirement update on same task identity
- **new** `agent.continue` (or equivalent): continue message to bound running lane without creating new dispatch identity

## 4.3 Session binding and anti-contamination

Persist and validate immutable binding tuple for active task:

- `taskId`
- `ownerAgentId`
- `boundSessionId`
- `projectPath`
- `revision`

If incoming action mismatches binding, fail fast with explicit scope error.

## 4.4 Reviewer permission hardening

Enforce reviewer “no execution dispatch” at runtime:

- keep `agent.dispatch` unavailable,
- restrict shell execution capability to verification-safe command set,
- reject any attempt to mutate project execution ownership.

## 4.5 Control-plane durability

Persist dispatch graph / route / lifecycle transitions in control lane store (restart-safe), not memory-only tracker.

---

## 5. Epic Deliverables

1. Prompt bundle update:
   - `system-prompt.md`
   - `project` prompt
   - `reviewer` prompt
2. Structured report schema + parser + integration.
3. Continue-lane tool support and routing guards.
4. Reviewer runtime permission hardening.
5. Session-binding validation and mismatch rejection.
6. Tests (unit/integration) for duplicate-dispatch suppression, reject-loop behavior, resume continuity.

---

## 6. Verification Matrix

1. System dispatches project task, then receives same-topic input:
   - expected: monitor/update path, no duplicate implementation by system.
2. Project submits incomplete claim:
   - expected: reviewer rejects incomplete claim; project continues.
3. Reviewer reject path:
   - expected: redispatch to project only, no system execution takeover.
4. Reviewer pass path:
   - expected: transition to pending_approval then system final summary.
5. Restart during in-progress:
   - expected: resume bound session/task, no duplicate dispatch.
6. Heartbeat no-op:
   - expected: no meaningless wake dispatch/no session pollution.

---

## 7. Rollout Strategy

Phase 1 (Prompt + guardrails):
- Land prompt constraints and runtime rejects for forbidden paths.

Phase 2 (Structured protocol):
- Switch report pipeline to structured payloads; keep compatibility shim for one iteration.

Phase 3 (Continuation lane + durability):
- Add continue path and control-plane persistence migration.

Phase 4 (Cleanup):
- Remove legacy text-only assumptions and redundant fallback branches.

