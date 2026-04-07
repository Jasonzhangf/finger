# Multi-Agent Prompt & Collaboration Hardening (Epic Plan V3)

> **Status**: Execution Plan (Authoritative for this epic)
> **Date**: 2026-04-01 (V2), 2026-04-07 (V3)
> **Related canonical lifecycle spec**: `docs/design/project-task-lifecycle-state-machine.md`
> **Reference baseline**: `~/code/codex` orchestrator/worker design patterns (adapted)

---

## 1. Objective

Close the current multi-agent reliability gaps by hardening:

1. prompt contracts (System Agent = Orchestrator+Reviewer, Project Agent = Worker),
2. runtime guardrails (state-machine + permission + session binding),
3. structured cross-agent result protocol (`CompletionClaim` schema),
4. resume/continue semantics (avoid repeated re-dispatch).

**V3 Changes (2026-04-07)**：
- Reviewer Agent 已合并到 System Agent
- System Agent 承担审核职责（"who dispatches who reviews"）
- 简化为 2-Agent 模型：System（Orchestrator+Reviewer） + Project（Worker）

Target outcome:
- System Agent plans/dispatches/monitors/**reviews** and does not re-implement delegated in-flight project tasks.
- Project Agent executes and produces **structured completion claim with evidence**.
- System Agent reviews claim → PASS → approve/report; REJECT → feedback for rework.
- Restart/heartbeat resumes from bound task/session without duplicate execution.

---

## 2. Design Inputs (Codex-inspired, Finger-adapted)

From `codex` we adopt these ideas:

1. **Coordinator role separation**: Orchestrator should coordinate, not duplicate worker execution.
2. **Structured worker notification contract**: Completion should not depend on free-form prose parsing.
3. **Continue existing worker/session**: When context overlap is high; avoid spawning duplicate lanes.
4. **Explicit concurrency discipline**: Parallel read/research, serialized write on overlapping scope.

Finger-specific adaptations:
- Keep existing `project.task.status` / `project.task.update` tools as primary pre-dispatch/update gates.
- Enforce **System ↔ Project** lifecycle (review merged into System Agent).
- Keep ledger control/reasoning lane separation and heartbeat no-noise policy.
- **New**: System Agent must call `project.review_claim` after receiving `project.claim_completion`.

---

## 3. Prompt Hardening Plan

### 3.1 System Agent prompt changes (Orchestrator + Reviewer)

Mandatory behavior (front-loaded):

1. Requirement clarification + execution contract confirmation before first project dispatch.
2. Pre-dispatch gate: must call `project.task.status` before any new dispatch.
3. If task is `dispatched|accepted|running|claimed_done|system_review`:
   - do not dispatch duplicate task,
   - do not implement same task in system lane,
   - only monitor or `project.task.update` when user explicitly requests requirement changes.
4. **After receiving claim_completion, must execute review logic**:
   - validate claim structure (taskId/summary/changedFiles/verification)
   - check verification status (must be 'pass')
   - check acceptance checklist (all items must be 'met')
   - decision: PASS → approve and report; REJECT → feedback with missing items
5. No out-of-scope execution: suggestions require user approval first.
6. **Never skip review**: Must not directly forward Project Agent output to user.

### 3.2 Project Agent prompt changes (Worker)

1. Executor-only responsibility for delegated task.
2. Stable task identity (`taskId`) across all updates/retries.
3. **Must submit structured completion claim** via `project.claim_completion`:
   - `taskId`: from dispatch
   - `summary`: concise completion description
   - `changedFiles`: list of modified files
   - `verification`: commands + outputs + status ('pass'|'fail')
   - `acceptanceChecklist`: criterion + status ('met'|'partial'|'not_met')
4. On System Agent REJECT: continue rework under same taskId.
5. **Never skip claim**: Must not end session without submitting claim.

### 3.3 Reviewer prompt changes (DELETED - merged into System Agent)

**V3 Change**: Independent Reviewer Agent role is removed.

Review responsibility is now part of System Agent prompt (see 3.1).

---

## 4. Runtime Hardening Plan

### 4.1 Structured cross-agent report contract

Replace text-only completion propagation with structured `CompletionClaim` schema:

```typescript
interface CompletionClaim {
  taskId: string;
  summary: string;
  changedFiles: string[];
  verification: {
    commands: string[];
    outputs: string[];
    status: 'pass' | 'fail' | 'partial';
  };
  acceptanceChecklist: {
    criterion: string;
    status: 'met' | 'partial' | 'not_met';
    evidence?: string;
  }[];
  claimedAt: string;
}
```

### 4.2 Continue-vs-dispatch separation

Introduce explicit continuation path for in-flight task/session:

- `agent.dispatch`: new assignment lane
- `project.task.update`: user-approved requirement update on same task identity
- `agent.continue`: continue message to bound running lane without creating new dispatch identity

### 4.3 Session binding and anti-contamination

Persist and validate immutable binding tuple for active task:

- `taskId`
- `ownerAgentId`
- `boundSessionId`
- `projectPath`
- `revision`

If incoming action mismatches binding tuple, reject as contamination attempt.

---

## 5. State Machine Updates

### 5.1 Simplified states (V3)

- `planned` → `dispatched` → `accepted` → `running` → `claimed_done` → `system_review` → `approved` → `completed`
- `system_review` → `rejected` → `running`

### 5.2 Transition guards

1. `dispatched|accepted|running|claimed_done|system_review` means ownership is in System↔Project path.
2. System Agent cannot execute same implementation task while task is in above states.
3. `approved` can only be entered by System Agent review PASS.
4. `rejected` triggers Project Agent rework under same taskId.

---

## 6. Tool Updates

| Tool | Owner | Description |
|------|-------|-------------|
| `project.claim_completion` | Project Agent | Submit structured claim |
| `project.review_claim` | System Agent | Audit claim + evidence |
| `project.approve_task` | System Agent | Mark task approved |
| `project.reject_task` | System Agent | Reject with feedback |
| `project.task.status` | System Agent | Query task state |

---

## 7. Summary of Changes from V2

| Item | V2 | V3 |
|------|----|----|
| Roles | 3 (System, Project, Reviewer) | 2 (System+Reviewer, Project) |
| Review flow | Reviewer validates | System Agent validates |
| Claim contract | Free-form text | Structured schema |
| States | `review_pending`, `review_rejected` | `system_review`, `rejected` |
