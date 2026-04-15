---
name: finger dev skills
description: Canonical execution skill for Finger repo development. Covers layer ownership, source-of-truth routing, minimal validation, and repo-specific pitfalls for design, refactor, debug, and feature work.
---

# Finger Dev Skills

## 0) Intent

This skill is the **project-local execution adapter** for Finger engineering work.

It exists to answer only four things:
1. **Which layer owns the change?**
2. **Where is the single source of truth?**
3. **What is the smallest correct change point?**
4. **What is the minimum validation required before handoff?**

It is **not** the place for full handbooks, long architecture specs, or duplicated hard guards.

## 0.1) Canonical sources

Use these sources in this order:

1. `AGENTS.md`
   - global hard guards, safety rules, validation discipline, worker/session rules
2. `references/layer-boundaries.md`
   - authoritative layer dependency and ownership rules
3. `templates/change-checklist.md`
   - handoff / validation template
4. `docs/design/*.md`
   - subsystem-specific design truth

If this skill disagrees with `AGENTS.md` or a subsystem design doc, **this skill is wrong** and must be updated.

---

## 1) When to use this skill

Use this skill for any Finger task involving:
- architecture or refactor
- runtime / session / lifecycle / dispatch
- context history / compact / rebuild
- channel / bridge / gateway flows
- cross-module debugging
- feature implementation that touches multiple layers

Do **not** use this skill as a substitute for reading the owning design doc when the task is subsystem-specific.

---

## 2) Finger execution workflow

### Step 1: classify the owning layer first

Use `references/layer-boundaries.md`.

#### Layer A — Core / Blocks / Runtime truth
Typical paths:
- `src/blocks/**`
- `src/runtime/**`
- core persistence / session truth in `src/orchestration/**`

Owns:
- deterministic state transitions
- persistence truth
- queue / scheduler primitives
- low-level runtime / tool primitives

Must not contain:
- channel formatting
- UI wording
- delivery-specific fallback logic

#### Layer B — Orchestration / App policy
Typical paths:
- `src/server/**`
- `src/serverx/**`
- `src/orchestration/**`
- role-policy glue in `src/agents/**`

Owns:
- workflow composition
- dispatch / recovery policy
- lifecycle wiring
- block composition
- rebuild policy using Layer A truth

Must not contain:
- duplicated persistence truth
- UI / channel rendering behavior

#### Layer C — Delivery / Consumer
Typical paths:
- `src/bridges/**`
- `src/ui/**`
- channel-facing output formatting / sanitization

Owns:
- rendering and presentation
- channel adaptation
- output sanitization

Must not contain:
- core lifecycle correctness logic
- blocking dependencies that prevent Layer A/B completion

### Step 2: find the single source of truth

Before editing, answer all three:
1. Where does the symptom appear?
2. Where does the truth live?
3. Is there any second implementation that would diverge after the fix?

If you cannot answer #3, keep searching before editing.

### Step 3: change only the owning layer

Rules:
- fix the root cause at the owning layer
- keep upper layers thin
- do not mirror business logic into bridges/UI
- do not create a second implementation “just for this flow”

### Step 4: validate in the smallest correct matrix

Choose the smallest set that proves the change.

---

## 3) Module quick map

| Need | Primary path |
|---|---|
| Block / core primitive | `src/blocks/<block-name>/` |
| Runtime / context / tool execution | `src/runtime/` |
| Orchestration / workflow | `src/orchestration/`, `src/serverx/modules/`, `src/server/modules/` |
| Agent policy / role behavior | `src/agents/` |
| Session / ownership / persistence | `src/orchestration/session-manager.ts`, `src/orchestration/session-types.ts` |
| Channel bridge / delivery | `src/bridges/`, `src/server/modules/channel-*` |
| Gateway bridge CLI | `src/cli/finger-gateway-bridge.ts` |
| Internal tools | `src/tools/internal/` |
| Unit tests | `tests/unit/**`, `tests/modules/**` |
| Integration tests | `tests/integration/**` |
| Orchestration tests | `tests/orchestration/**` |
| E2E tests | `tests/e2e/**`, `tests/e2e-ui/**` |

---

## 4) Minimal validation matrix

### A. Localized logic change
Run targeted unit tests first:

```bash
pnpm vitest run tests/unit/<path>/*.test.ts
```

### B. Cross-module change
Run unit + integration:

```bash
pnpm vitest run tests/unit/<path>/*.test.ts
pnpm vitest run tests/integration/<path>/*.test.ts
```

### C. Lifecycle / session / dispatch / context-history change
Run the relevant targeted tests, then these repo gates:

```bash
pnpm run test:session-regression
pnpm run test:compact-projection-regression
```

Run `test:compact-projection-regression` when compact / projection / rebuild / session snapshot behavior is touched.

### D. Runtime/backend change before handoff

```bash
pnpm run build:backend
```

### E. Channel / external interface change
Use inside-out order:

1. unit: routing / normalization / session selection
2. integration: bridge ↔ hub ↔ runtime coordination
3. E2E: real bridge process / real message path when required

Typical commands:

```bash
pnpm vitest run tests/unit/server/channel-*.test.ts tests/unit/server/dispatch-session-selection.test.ts
pnpm vitest run tests/integration/bridges/*.test.ts
pnpm vitest run tests/e2e/gateway-bridge-*.test.ts
```

### F. Type gate
Use the smallest suitable TS gate for the change. If backend build is already run, do not duplicate a weaker TS-only gate.

---

## 5) Repo-specific invariants worth remembering

### 5.1 Core must never be blocked by delivery failures
If a bridge / channel / presentation path fails:
1. persist core result first
2. expose failure explicitly
3. do not block core completion or recovery

### 5.2 Worker-owned session model is strict
Follow `AGENTS.md` as the hard truth.

Practical rule:
- session ownership is not transferred by visibility scope
- cross-agent read is allowed
- cross-worker write / execute is not
- fixes must preserve deterministic session mapping

### 5.3 Context history has one canonical implementation
For context-history work, the canonical paths are:
- runtime core: `src/runtime/context-history/**`
- digest write path: `src/runtime/context-history-compact.ts`
- runtime session truth: `Session.messages`
- explicit tool name: `context_history.rebuild`

Rules:
- do **not** reintroduce `context_builder.*` as the primary path
- do **not** split compact and rebuild into competing flows
- do **not** add a second history projection pipeline in agent / bridge / route layers
- if behavior changes, update the owning design doc under `docs/design/`

### 5.4 Channel bugs must be debugged inside-out
Never start with “real QQBot must be broken”.

Debug order:
1. internal route logic
2. module coordination
3. bridge / external service

### 5.5 Avoid stale exact facts in the skill
Do not store fragile facts here such as:
- exact `console.*` counts
- exact line counts
- “current ports in use” snapshots
- temporary migration state

Those facts expire quickly and corrupt the skill.

---

## 6) High-value anti-patterns

Forbidden patterns for this repo:
- fixing a Layer A truth problem in Layer C presentation code
- duplicating persistence truth in orchestration or bridges
- adding fallback branches to hide a real lifecycle / dispatch error
- claiming “done” with only happy-path tests
- reporting completion without command output or direct evidence
- introducing a second compact / rebuild / session-recovery implementation
- keeping obsolete names or commands in the skill after the codebase has moved on

---

## 7) Handoff requirements

Before handoff, report:
1. files changed
2. why those files are the owning layer
3. validation commands actually run
4. remaining risks / skipped checks

Use `templates/change-checklist.md` when the task is non-trivial.

---

## 8) Skill maintenance rule

Update this skill only when the repo gains a **stable, reusable execution rule**.

Do not append:
- long historical postmortems
- subsystem handbooks
- exact temporary metrics
- one-off migration notes
- duplicated AGENTS rules

If a new rule is subsystem-specific, put it in `docs/design/` or a dedicated skill instead.
