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

### 4.1 Closure rule: testing must be inside-out and closed-loop

Every feature and bug fix must be tested **from the innermost owning logic outward to the real entry path**.

The default Finger testing stack has **5 layers**:

| Layer | Goal | Typical test roots | Must answer |
|---|---|---|---|
| **L1 Internal Unit** | verify the smallest owning logic | `tests/unit/**`, `tests/modules/**` | “Did the real owning function/class/route logic change correctly?” |
| **L2 Module Integration** | verify handoff between modules | `tests/integration/**` | “Do the modules still work together across the boundary I touched?” |
| **L3 Workflow / Regression Gate** | verify lifecycle/session/runtime invariants | repo scripts + focused integration regression | “Did I break project-wide invariants?” |
| **L4 Local E2E** | verify user-facing local full path | `tests/e2e/**`, `tests/e2e-ui/**` | “Does the whole local path behave correctly?” |
| **L5 Real Runtime / Online Verification** | verify deployed/installed/real external path | installed daemon / manual real scripts / real route | “Does the actual runtime users rely on still work?” |

**Done means all applicable layers have passed.**  
If L5 is applicable, stopping at L1-L4 is **not** completion.

### 4.2 Standard execution order (must follow)

For every change:

1. **Identify owning path**
2. **Pick the applicable test stack**
3. **Run L1 first**
4. **Then L2**
5. **Then L3 project gates**
6. **Then L4 local E2E if the change reaches a user/runtime entry**
7. **Then L5 real runtime / online verification if the change will actually be installed, deployed, or used through a real external interface**

Do not jump directly to E2E to “see if it works”.  
Do not stop after unit tests if the change crosses boundaries.

### 4.3 How to choose the exact tests, not just the layer name

Do not run a vague “some unit tests”.

For every change, select tests in this order:
1. **same noun** — tests sharing the module/domain noun you changed (`context-history`, `compact`, `session`, `channel`, `daemon`, `upgrade`, `runtime-panel`)
2. **same boundary** — the next layer where that module hands off to another module
3. **same user path** — the real entry path users hit
4. **same shipped path** — the installed / running / external path if applicable

Practical rule:
- if you changed `src/runtime/context-history/**`, start with `tests/unit/runtime/context-history*`
- if you changed `src/server/channel-*`, start with `tests/unit/server/channel-*`
- if you changed `src/cli/**`, start with `tests/unit/cli/*`
- if you changed `session-manager`, `dispatch`, `compact`, `rebuild`, also pull the session regression gates even if the direct file name differs

If the direct owning test does not exist yet, add/fix that L1 test first. Do **not** skip inward layers because an outer e2e happens to fail.

### 4.4 Fixed playbooks by change type

Use these as the default operational recipes.

#### Playbook A — runtime / context-history / compact / rebuild / session truth

Use this when touching:
- `src/runtime/**`
- `src/orchestration/session-*`
- `src/server/**` code that changes session selection, compact, rebuild, or ledger → session sync

**L1 Internal Unit**

```bash
pnpm vitest run \
  tests/unit/runtime/context-history/executor.test.ts \
  tests/unit/runtime/context-history-compact.test.ts \
  tests/unit/runtime/context-history-compact-integrity.test.ts \
  tests/unit/runtime/context-ledger-memory.test.ts \
  tests/unit/runtime/auto-compact.test.ts \
  tests/unit/runtime/runtime-facade-compaction-summarizer.test.ts \
  tests/unit/orchestration/context-ledger-compact.regression.test.ts \
  tests/unit/server/message-route-execution-compact-session-sync.test.ts
```

Add the nearest session-owner tests when ownership / ordering / fallback changed:

```bash
pnpm vitest run \
  tests/unit/orchestration/session-manager-message-order.test.ts \
  tests/unit/orchestration/session-manager-ledger-fallback.test.ts \
  tests/unit/orchestration/session-manager-transient-ledger-resilience.test.ts
```

**L2 Module Integration**

```bash
pnpm vitest run \
  tests/integration/runtime/compact-integration.test.ts \
  tests/integration/context-lifecycle-regression.test.ts \
  tests/integration/session-manager-persistence.test.ts \
  tests/integration/session-compact-projection-regression.test.ts
```

**L3 Workflow / Regression Gate**

```bash
pnpm run test:session-regression
pnpm run test:compact-projection-regression
pnpm run build:backend
```

**L4 Local E2E**

```bash
pnpm vitest run tests/e2e/context-history-rebuild.test.ts
```

**L5 Real Runtime / Online Verification**

```bash
npm run build:install
npm run daemon:start
npm run evidence:context-rebuild:real-runtime
```

Only claim done when the rebuilt context path is verified through the real installed runtime or an equivalent real request path.

#### Playbook B — channel / bridge / gateway / QQBot

Use this when touching:
- `src/bridges/**`
- `src/server/modules/channel-*`
- `src/server/**` route/session selection used by channel delivery
- `src/cli/finger-gateway-bridge.ts`

**L1 Internal Unit**

```bash
pnpm vitest run \
  tests/unit/bridges/channel-bridge-input.test.ts \
  tests/unit/bridges/channel-bridge-output.test.ts \
  tests/unit/server/channel-bridge-hub-route.test.ts \
  tests/unit/server/channel-bridge-loading.test.ts \
  tests/unit/server/channel-link-auto-detail.test.ts \
  tests/unit/server/channel-session-selection.test.ts \
  tests/unit/server/dispatch-session-selection.test.ts
```

**L2 Module Integration**

```bash
pnpm vitest run \
  tests/integration/bridges/channel-bridge-hub-integration.test.ts \
  tests/integration/channel-session-routing.test.ts
```

**L3 Workflow / Regression Gate**

```bash
pnpm run test:session-regression
pnpm run build:backend
```

**L4 Local E2E**

```bash
pnpm vitest run tests/e2e/gateway-bridge-qqbot.test.ts
```

**L5 Real Runtime / Online Verification**

```bash
npm run build:install
npm run daemon:start
node tests/manual/test-channel-e2e-real.mjs
node tests/manual/test-qqbot-e2e.mjs
node tests/manual/test-real-qqbot.mjs
```

For channel work, L5 is the first layer that proves the real external edge is still correct. L1-L4 alone are not enough for “上线可用”.

#### Playbook C — daemon / CLI / upgrade / installed runtime

Use this when touching:
- `src/cli/**`
- `src/daemon/**`
- upgrade pipeline / package manager / health check wiring

**L1 Internal Unit**

```bash
pnpm vitest run \
  tests/unit/cli/daemon.test.ts \
  tests/unit/cli/upgrade.test.ts \
  tests/unit/orchestration/daemon.test.ts \
  tests/unit/orchestration/pre-upgrade-health-check.test.ts \
  tests/unit/orchestration/upgrade-engine.test.ts \
  tests/unit/orchestration/upgrade-package-manager.test.ts \
  tests/unit/scripts/daemon-process-matchers.test.ts
```

**L2 Module Integration**

```bash
pnpm vitest run \
  tests/integration/daemon-guard/daemon-guard.test.ts \
  tests/integration/system-agent-runtime.test.ts \
  tests/integration/module-upgrade-integration.test.ts \
  tests/integration/full-upgrade-pipeline.test.ts \
  tests/integration/runtime-e2e-verification.test.ts
```

**L3 Workflow / Regression Gate**

```bash
pnpm run build:backend
```

**L4 Local E2E**

If there is a dedicated local e2e for the exact path, run it. If not, promote directly from L3 to L5; do **not** pretend integration already equals installed-runtime verification.

**L5 Real Runtime / Online Verification**

```bash
npm run build:install
npm run daemon:start
```

Then execute the real installed CLI / daemon path you changed and capture the real output/log evidence.

#### Playbook D — UI / session panel / runtime panel

Use this when touching:
- `src/ui/**`
- UI contracts consumed by runtime/session panels

**L1 Internal Unit**

```bash
pnpm vitest run \
  tests/unit/ui/agent-session-panel.test.ts \
  tests/unit/ui/runtime-auto-switch.test.tsx \
  tests/unit/cli/session-panel.test.ts
```

**L4 Local E2E**

```bash
pnpm vitest run \
  tests/e2e-ui/contracts/api-contracts.test.ts \
  tests/e2e-ui/contracts/error-contracts.test.ts \
  tests/e2e-ui/contracts/schema-validation.test.ts \
  tests/e2e-ui/flows/create-session-flow.test.ts \
  tests/e2e-ui/flows/dispatch-task-flow.test.ts \
  tests/e2e-ui/flows/runtime-panel-flow.test.ts \
  tests/e2e-ui/stability/long-running-session.test.ts \
  tests/e2e-ui/stability/memory-pressure.test.ts \
  tests/e2e-ui/stability/reconnect.test.ts
```

**L5 Real Runtime / Online Verification**

```bash
pnpm run build:ui
pnpm run test:ui
```

Then open the real running UI path you changed and verify the actual interaction, not only the contract tests.

### 4.5 Path → required minimum stack

Use this table directly.

| Changed area | Minimum stack |
|---|---|
| `src/blocks/**`, pure utils, pure runtime helpers with no outward boundary | direct L1 only |
| `src/runtime/**`, `src/core/**` | Playbook A through L3; if user/runtime entry changed, continue to L4/L5 |
| session / lifecycle / dispatch / compact / rebuild | full Playbook A, normally through L5 |
| `src/orchestration/**`, `src/server/**`, `src/serverx/**` | L1 → matching L2 → matching L3; if user path changed, continue outward |
| channel / bridge / gateway / QQBot | full Playbook B through L5 |
| agent prompt / tool wiring / context injection | nearest L1 + targeted L2; add L3 if runtime behavior changed |
| CLI / daemon / upgrade | full Playbook C through L5 |
| `src/ui/**` | Playbook D through L4; if shipped/running UI changed, continue to L5 real interaction |

### 4.6 When work is actually done

Use this completion rule, not intuition:

- **Only L1 passed** → owning logic is better, but the feature/fix is **not done**
- **L1 + L2 passed** → module boundary looks good, but end-user path is **not done**
- **L3 passed** → repo invariants still hold, but user path may still be broken
- **L4 passed** → local full path works
- **L5 passed (when applicable)** → real installed / deployed / external path works, now it can be called complete

Typical done thresholds:
- pure internal helper refactor with no outward behavior change → may stop at L1
- runtime/session/dispatch change → usually stops only after L3 or L4, and often L5
- channel / external bridge / daemon / installed CLI / shipped UI change → must reach L5

### 4.7 Mandatory stop conditions

Stop and fix before moving outward if:
- L1 fails → fix owning logic first
- L2 fails → fix boundary contract first
- L3 fails → do not hand off
- L4 fails → do not claim local full path works
- L5 is applicable and missing → do not claim “done” / “可上线” / “已闭环”

---

## 5) Repo-specific invariants worth remembering

> ⚠️ 以下规则如有冲突，以 `AGENTS.md` 为准。仅记录本项目的**额外约束**，不在此处重复 AGENTS 中的通用规则。

### 5.1 Context history has one canonical implementation
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

> ⚠️ 以下是本项目的额外反模式。通用规则见 `AGENTS.md`。

**项目特有：**
- introducing a second compact / rebuild / session-recovery implementation
- keeping obsolete names or commands in the skill after the codebase has moved on

> ⚠️ 通用反模式见 `AGENTS.md`：`禁止静默失败`、`非授权不破坏`、`禁止 broad kill`。

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
