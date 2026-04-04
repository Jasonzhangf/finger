---
name: finger dev skills
description: Project development guardrails for Finger. Defines layered architecture, module ownership, core-priority invariants, and mandatory change/testing workflow. Use for any design, refactor, debug, or feature work in this repo.
---

# Finger Dev Skills

## 0) Intent

This skill is the project-local execution contract for Finger engineering work.

Use this skill whenever you touch architecture, core runtime, orchestration, dispatch/recovery, context rebuild, progress/reporting, or cross-agent collaboration logic.

## 1) Non-negotiable priorities (MUST)

1. **Core runtime forward progress is P0.**
   - Consumer/presentation layers must never block core execution.
   - If consumer side fails, core still progresses and persists state.

2. **No silent failure.**
   - Any failure in dispatch, lifecycle update, progress emit, hook, or persistence must be observable (status + reason + evidence).

3. **Restart semantics are strict.**
   - Non-restart path: in-process continuation is allowed within bounded policy.
   - Post-restart path: never pretend to continue stale in-flight kernel state; recover via persisted lifecycle truth.

4. **Root-cause fixes only.**
   - No workaround-only patches.
   - No “looks-fixed” response without code-path evidence and tests.

5. **Layer contracts are hard constraints.**
   - Put behavior in the correct layer; do not leak business logic upward/downward.

## 2) Layer model and ownership

Reference: `references/layer-boundaries.md`.

### Layer A — Core/Blocks (truth layer)
- Paths (main): `src/blocks/**`, `src/runtime/**`, `src/orchestration/session-manager*`, core lifecycle primitives.
- Responsibility:
  - deterministic state transitions
  - persistence truth
  - queue/scheduler primitives
  - tool execution primitives
- Rule: no channel/UI-specific behavior here.

### Layer B — Orchestration/App (policy layer)
- Paths (main): `src/serverx/**`, `src/server/**`, `src/orchestration/**`, `src/agents/**` (role policy / workflow decisions).
- Responsibility:
  - compose blocks into workflows
  - dispatch/recovery policy
  - context rebuild policy
  - control block + stop gate policy wiring
- Rule: do not violate core invariants.

### Layer C — Delivery/Consumer (presentation layer)
- Paths (main): `src/ui/**`, channel bridge outputs, user-facing formatting/sanitization.
- Responsibility:
  - render progress
  - sanitize output
  - channel-specific UX
- Rule: failures here cannot block Layer A/B completion.

## 3) Skeleton design requirements

1. Every task must have explicit lifecycle:
   - `received -> dispatching/running -> waiting_* -> completed|failed|interrupted`
2. Terminal state cannot be regressed by stale/out-of-order events.
3. Session mapping must be deterministic by scope (system/project/reviewer).
4. Heartbeat/control sessions are isolated from normal user sessions.
5. Persist-before-consume for critical state transitions.

## 4) Mandatory change workflow

1. **Classify scope first**
   - Which layer owns the change? (A/B/C)
   - Which invariant can be broken if wrong?

2. **Define acceptance before coding**
   - Expected lifecycle transitions
   - Expected recovery behavior on restart
   - Expected observability (progress/error evidence)

3. **Implement minimal root-cause diff**
   - No broad unrelated refactor in same patch.

4. **Add/adjust regression tests in same change**
   - Include at least one failure-path or out-of-order/pathological case.

5. **Run verification stack**
   - Targeted tests for touched modules
   - Type check
   - session regression
   - backend build pipeline

6. **Deliver with evidence**
   - what changed
   - why root cause is fixed
   - test outputs
   - remaining risks/corner cases

## 5) Mandatory test flow

### Fast gate (while iterating)
- `npm test -- <target-test-files>`
- `npx tsc --noEmit`

### Session/runtime gate (required for session/lifecycle/dispatch changes)
- `npm run test:session-regression`

### Full backend gate (required before handoff for runtime changes)
- `npm run build:backend`

## 6) Change checklist (copy into task execution)

Use template: `templates/change-checklist.md`.

Required pass criteria:
- [ ] Correct layer ownership
- [ ] Core non-blocking invariant preserved
- [ ] Restart/non-restart semantics validated
- [ ] Terminal lifecycle non-regression validated
- [ ] Failure observability validated
- [ ] Regression tests added/updated
- [ ] Verification commands passed

## 7) Anti-patterns (forbidden)

- Letting progress/reporting pipeline block core completion.
- Treating restart as if in-flight kernel execution is still live.
- Overwriting terminal lifecycle with stale event updates.
- Dispatch failure hidden as success or no-op.
- “Fixing” by adding fallback branches that bypass real constraints.
