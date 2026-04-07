# Unified Task Lifecycle & Session Control (Canonical Spec V3)

> **Status**: Authoritative / Single Source of Truth  
> **Scope**: System Agent (Manager+Reviewer) ↔ Project Agent (Worker), heartbeat recovery, session routing, context policy  
> **Last updated**: 2026-04-07

---

## 0) Why this doc exists

This document is the **only canonical design** for:

1. task lifecycle state machine (simplified 2-agent model);
2. system/project interaction contract (review merged into System Agent);
3. heartbeat/watchdog recovery policy;
4. session routing and anti-contamination rules;
5. context rebuild/compaction boundaries.

**V3 Changes (2026-04-07)**:
- Removed independent Reviewer Agent role.
- Review responsibility merged into System Agent ("who dispatches who reviews").
- Simplified state machine: `claimed_done -> system_review -> approved/rejected`.
- Removed `review_pending`, `review_rejected`, `pending_approval` states.

Any older design doc that overlaps these topics is superseded by this document.

---

## 1) Core architecture: one ledger, two tracks

All events are persisted in one ledger with explicit `track`:

- `reasoning` track
  - user input, assistant outputs, tool calls/results, task summaries.
  - used by context builder and model prompt assembly.
- `control` track
  - dispatch/review state changes, heartbeat/watchdog actions, recovery decisions.
  - **never injected into model history**; used for scheduling and lifecycle decisions only.

### Hard rule

`control` events must not mutate the reasoning-history prompt window.

---

## 2) Role contract (Simplified)

### 2.1 System Agent (Manager + Reviewer)

**Primary Identity**: Orchestrator. Responsible for understanding user intent, dispatching tasks, **reviewing results**, and delivering final outcomes to user.

**Core Responsibilities**:
1. **Requirement clarification**: Understand user request, define acceptance criteria.
2. **Dispatch**: Delegate implementation tasks to Project Agent via `agent.dispatch`.
3. **Monitor**: Track task progress without interference.
4. **Review**: Audit Project Agent's completion claim with evidence.
   - Check: changed files, verification output, acceptance checklist.
   - Decision: `PASS` → approve and report to user; `REJECT` → feedback for rework.
5. **Deliver**: Only after review PASS, summarize result to user.

**Hard Rules**:
- Must NOT implement the same in-flight project task after dispatch.
- Must NOT skip review and directly forward Project Agent output to user.
- Must NOT play "pass-through proxy" role; must actively audit evidence.

### 2.2 Project Agent (Worker)

**Primary Identity**: Executor. Responsible for implementing tasks and producing verifiable evidence.

**Core Responsibilities**:
1. **Execute**: Implement according to System Agent's task specification.
2. **Self-verify**: Run tests, build, or validation commands before claiming completion.
3. **Claim**: Submit structured completion claim via `project.claim_completion`:
   - `taskId`: Task identifier from dispatch.
   - `summary`: Concise completion summary.
   - `changedFiles`: List of modified files.
   - `verification`: Test results, command outputs, logs.
   - `acceptanceChecklist`: Status of each acceptance criterion.
4. **Rework**: If System Agent REJECTs claim, fix issues and resubmit under same taskId.

**Hard Rules**:
- Must NOT submit claim without verification evidence.
- Must NOT skip claim and directly end session.
- Must NOT respond to user directly (System Agent owns user interaction).

---

## 3) Canonical task state machine (Simplified)

### 3.1 States

| State | Owner | Description |
|-------|-------|-------------|
| `planned` | System Agent | Task identified, awaiting dispatch |
| `dispatched` | System Agent → Project Agent | Task delegated, awaiting acceptance |
| `accepted` | Project Agent | Project Agent acknowledged task |
| `running` | Project Agent | Implementation in progress |
| `claimed_done` | Project Agent | Claim submitted with evidence |
| `system_review` | System Agent | System Agent auditing claim |
| `approved` | System Agent | Review PASS, ready to report |
| `rejected` | System Agent | Review REJECT, feedback sent |
| `completed` | System Agent | Task done, reported to user |
| `failed` | System Agent | Task failed, reported to user |
| `cancelled` | System Agent | Task cancelled by user or system |
| `stalled` | System Agent | Timeout/interrupted, recoverable |

### 3.2 Allowed transitions

```text
planned -> dispatched -> accepted -> running -> claimed_done -> system_review
system_review -> approved -> completed
system_review -> rejected -> running

running -> stalled -> running            (resume path)
any active state -> failed|cancelled     (terminal path)
```

### 3.3 Transition guards

1. `dispatched|accepted|running|claimed_done|system_review` means ownership is in System↔Project interaction path.
2. While state in the set above, System Agent cannot execute same implementation task.
3. `approved` can only be entered by System Agent review PASS.
4. `rejected` triggers Project Agent rework loop (same taskId).

---

## 4) End-to-end lifecycle (ASCII)

```text
User request
   |
   v
System Agent (clarify + plan + acceptance contract)
   |
   | dispatch(taskId, owner=project)
   v
[dispatched] -> [accepted] -> [running]
                               |
                               | project.claim_completion(evidence)
                               v
                          [claimed_done]
                               |
                               v
                          [system_review]
                          /            \
                     REJECT              PASS
                        |                  |
                        v                  v
                 [rejected]            [approved]
                        |                  |
                        +-------> [running]|
                                           v
                                     System final user summary
                                           |
                                           v
                                      [completed]
```

---

## 5) Structured completion claim contract

### 5.1 Claim payload schema

```typescript
interface CompletionClaim {
  taskId: string;
  summary: string;              // Concise description of what was done
  changedFiles: string[];       // Absolute paths of modified files
  verification: {
    commands: string[];         // Commands run for verification
    outputs: string[];          // Key outputs (test pass, build success)
    status: 'pass' | 'fail' | 'partial';
  };
  acceptanceChecklist: {
    criterion: string;
    status: 'met' | 'partial' | 'not_met';
    evidence?: string;
  }[];
  claimedAt: string;            // ISO timestamp
}
```

### 5.2 Review decision schema

```typescript
interface ReviewDecision {
  taskId: string;
  decision: 'PASS' | 'REJECT';
  evidenceCheck: {
    changedFilesVerified: boolean;
    verificationPassed: boolean;
    acceptanceCriteriaMet: boolean;
  };
  feedback?: string;            // REJECT reason, specific issues
  missingItems?: string[];      // What's missing for PASS
  reviewedAt: string;
}
```

---

## 6) Heartbeat/watchdog and recovery

### 6.1 Execution lane isolation

- heartbeat/watchdog run in **control lane**.
- no-op checks do not append reasoning history.
- no-op checks do not push user-facing progress noise.

### 6.2 Recovery algorithm (every heartbeat tick)

1. scan open tasks (state in `dispatched|accepted|running|claimed_done|system_review|stalled`).
2. for each task:
   - if `stalled` and last activity > timeout → resume or fail.
   - if `running` and no heartbeat from Project Agent → mark `stalled`, trigger recovery dispatch.
   - if `claimed_done` and no System Agent review within timeout → flag for immediate review.

### 6.3 Session binding anti-contamination

- each task binds to immutable tuple: `(taskId, sessionId, projectPath, ownerAgentId)`.
- resume dispatch must reuse same tuple; no duplicate lane creation.
- reasoning history must not be contaminated by control-track events.

---

## 7) Context rebuild/compaction boundaries

### 7.1 When to rebuild

- topic switch detected (different project or unrelated task).
- user explicitly requests context cleanup.
- System Agent detects history noise from multiple interleaved threads.

### 7.2 When to compact

- context usage exceeds threshold (e.g., 80%).
- compact only reasoning track; never compact control track.
- keep recent N turns + important landmarks (dispatch, claim, review decisions).

---

## 8) Summary of changes from V2

| Item | V2 (Old) | V3 (New) |
|------|----------|----------|
| Roles | 3 (System, Project, Reviewer) | 2 (System+Reviewer, Project) |
| Review owner | Independent Reviewer Agent | System Agent |
| States | `review_pending`, `review_rejected`, `pending_approval` | `system_review`, `rejected`, `approved` |
| Claim contract | Free-form text | Structured `CompletionClaim` schema |
| Review contract | Reviewer output | System Agent `ReviewDecision` |
