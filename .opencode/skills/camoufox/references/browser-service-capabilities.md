# Camo Capability Mapping (camo-only)

This reference maps runtime capabilities to `camo` commands.
No direct HTTP/API calls are required when using this skill.

## 1. Service & Session Lifecycle

- bootstrap runtime: `camo init`
- session create/reuse: `camo start [profile] [--url ...]`
- session inspect: `camo status [profile]`, `camo sessions`
- session close: `camo stop [profile]`
- force cleanup: `camo cleanup ...`, `camo force-stop ...`, `camo shutdown`

## 2. Browser/Page Primitives

- navigate: `camo goto`, `camo back`
- screenshot: `camo screenshot`
- tabs: `camo new-page`, `camo switch-page`, `camo close-page`, `camo list-pages`
- viewport/window: `camo viewport`, `camo window move`, `camo window resize`

## 3. Element/Interaction Primitives

- protocol actions: `camo click`, `camo type`, `camo scroll`
- debug assist: `camo highlight`, `camo clear-highlight`
- system fallback: `camo mouse move/click/wheel`

## 4. Container Subscription Layer

- init + migrate sets: `camo container init`
- enumerate set IDs: `camo container sets`
- bind set IDs to profile: `camo container register`
- inspect active target selectors: `camo container targets`
- filter/list/watch live DOM: `camo container filter/list/watch`

## 5. Strategy Layer (Autoscript)

- scaffold template: `camo autoscript scaffold xhs-unified`
- schema/graph checks: `camo autoscript validate`, `camo autoscript explain`
- execution: `camo autoscript run`
- resumability: `camo autoscript snapshot`, `camo autoscript resume`
- deterministic replay/mock: `camo autoscript replay`, `camo autoscript mock-run`

## 6. Progress & Diagnostics

- ws daemon: `camo events serve`
- live tail: `camo events tail`
- persisted recent: `camo events recent`
- manual marker: `camo events emit`

Recommended failure triage order:
1. `camo status <profile>`
2. `camo screenshot <profile> --output ...`
3. `camo events recent --limit 80`
4. `camo events tail --mode autoscript --replay 50`
5. `camo sessions` + cleanup commands if ownership/lock issue

## 7. XHS Safety Invariants

- Do not construct detail/search URLs manually in automation.
- Prefer container/protocol path before mouse fallback.
- Keep visible-state checks in workflow (exist/appear should be visibility-aware).
- For risky actions, keep evidence snapshots + event logs.
