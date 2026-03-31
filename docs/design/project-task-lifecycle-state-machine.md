# Unified Task Lifecycle & Session Control (Canonical Spec)

> Status: **Authoritative / Single Source of Truth**  
> Scope: System Agent ↔ Project Agent ↔ Reviewer Agent, heartbeat recovery, session routing, context policy  
> Last updated: 2026-03-31

---

## 0) Why this doc exists

This document is the **only canonical design** for:

1. task lifecycle state machine;
2. system/project/reviewer interaction contract;
3. heartbeat/watchdog recovery policy;
4. session routing and anti-contamination rules;
5. context rebuild/compaction boundaries.

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

## 2) Role contract

### 2.1 System agent (manager)

- owns requirement clarification and planning.
- dispatches execution tasks to project agent.
- monitors state and reports final outcome to user.
- must not implement the same in-flight project task after dispatch.

### 2.2 Project agent (executor)

- owns implementation and verification evidence.
- can iterate until completion.
- must submit explicit completion claim (with evidence) to enter review.

### 2.3 Reviewer agent (validator)

- only validates against acceptance criteria.
- outputs `PASS` or `REJECT` + evidence.
- **must not dispatch tasks to other agents**.
- `REJECT` returns to project loop directly; no system execution handoff.

---

## 3) Canonical task state machine

## 3.1 States

- `planned`
- `dispatched`
- `accepted`
- `running`
- `claimed_done`
- `review_pending`
- `review_rejected`
- `pending_approval`
- `completed`
- `failed`
- `cancelled`
- `stalled` (timeout/interrupted, recoverable)

## 3.2 Allowed transitions

```text
planned -> dispatched -> accepted -> running -> claimed_done -> review_pending
review_pending -> review_rejected -> running
review_pending -> pending_approval -> completed

running -> stalled -> running            (resume path)
any active state -> failed|cancelled     (terminal path)
```

### Transition guards

1. `dispatched|accepted|running|review_pending` means ownership is project/reviewer path.
2. while state in the set above, system cannot execute same implementation task.
3. `pending_approval` can only be entered by reviewer PASS.

---

## 4) End-to-end lifecycle (ASCII)

```text
User request
   |
   v
System Agent (clarify + plan + acceptance contract)
   |
   | dispatch(taskId, revision, owner=project)
   v
[dispatched] -> [accepted] -> [running]
                               |
                               | completion claim + evidence
                               v
                          [review_pending]
                          /            \
                     REJECT              PASS
                        |                  |
                        v                  v
                 [review_rejected]   [pending_approval]
                        |                  |
                        +-------> [running]|
                                           v
                                     System final user summary
                                           |
                                           v
                                      [completed]
```

---

## 5) Heartbeat/watchdog and recovery

## 5.1 Execution lane isolation

- heartbeat/watchdog run in **control lane**.
- no-op checks do not append reasoning history.
- no-op checks do not push user-facing progress noise.

## 5.2 Recovery algorithm (every heartbeat tick)

1. scan open tasks from `control` track.
2. for each monitored agent:
   - if state is active and runtime is idle/interrupted -> resume bound session.
   - if state is `completed|failed|cancelled` -> skip.
3. never create duplicate execution for same `taskId`.

## 5.3 Tick cadence

- default heartbeat cadence: **5 minutes**.
- no actionable work => no wake-up dispatch.

---

## 6) Session routing and continuity

## 6.1 Binding model

Each active task stores stable bindings in control state:

- `taskId`
- `ownerAgentId`
- `boundSessionId`
- `flowId`
- `revision`
- `status`

## 6.2 Resume-first policy

When task not completed:

1. resume `boundSessionId`;
2. do not create new session;
3. do not rebuild history.

Only create a new session when:

- new task without reusable binding; or
- explicit user/requested new-session mode.

---

## 7) Context policy (strict)

Runtime context is split into two sections:

1. `context_history` (rebuilt/compacted history view)
2. `current_session_context` (append-only live turns)

### Hard invariants

1. no implicit rebuild on new turn.
2. no rebuild from heartbeat/mailbox/control events.
3. rebuild is allowed only when:
   - explicit rebuild tool call;
   - context overflow threshold reached;
   - bootstrap with empty history.

### Compaction retention (must keep)

- user request summary;
- task completion summary;
- `update_plan` key steps;
- dispatch/update-task/review result calls;
- report-task-completion evidence pointer.

---

## 8) Anti-duplication and anti-conflict rules

1. dispatch precheck: if same target project has open matching task -> reject new dispatch, require `update_task`.
2. self-dispatch (`sourceAgentId == targetAgentId`) -> hard error.
3. reviewer dispatch ability -> forbidden by policy and tool permissions.
4. stale watchdog no-op must close obsolete active flags where applicable.

---

## 9) Progress update contract

Every progress emission must include:

- `role` (`system|project|reviewer`)
- `agentId`
- `sessionId`
- `taskId` + state
- actionable step summary
- context usage + reason for changes (`growth|compaction|rebuild|session_switch`)

No actionable work => no progress update.

---

## 10) Failure handling

## 10.1 Timeout or provider stall

When execution timeout occurs (e.g. `chat-codex timed out after 600000ms`):

1. write control event `stalled` with reason;
2. preserve task/session binding;
3. heartbeat resumes from same bound session;
4. do not reset/rebuild reasoning context automatically.

## 10.2 Review failure

- review reject returns to project running state.
- system is not asked to execute rejected implementation directly.

---

## 11) Acceptance checklist

- [ ] System does not re-implement dispatched in-flight project task.
- [ ] Reviewer cannot dispatch tasks.
- [ ] REJECT loops project -> reviewer without system execution takeover.
- [ ] PASS transitions to `pending_approval`, then system closes.
- [ ] Heartbeat runs in control lane and does not pollute reasoning history.
- [ ] No implicit rebuild on normal new turns.
- [ ] Active tasks resume from bound sessions after restart.

---

## 12) Superseded docs

The following documents are kept only as historical references and must not define runtime behavior:

- `docs/design/system-project-ledger-lifecycle.md`
- `docs/design/cross-agent-update-framework.md`
- `docs/design/agent-recovery-design.md`
- `docs/design/ledger-only-dynamic-session-views.md` (for historical rationale only)

---

## 13) Active execution plan (prompt + collaboration hardening)

For current execution details of prompt constraints and multi-agent collaboration hardening, see:

- `docs/design/multi-agent-prompt-collaboration-hardening-epic.md`

This section is an execution companion to this canonical lifecycle spec.
If conflicts occur, lifecycle/state-machine rules in this document remain authoritative.
