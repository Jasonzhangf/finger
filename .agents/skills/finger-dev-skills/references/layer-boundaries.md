# Finger Layer Boundaries (Authoritative)

## Dependency direction (strict)

Allowed direction:

- Layer C (Delivery/UI) -> Layer B (Orchestration/App) -> Layer A (Core/Blocks)

Disallowed direction:

- Layer A -> Layer B/C
- Layer B -> Layer C
- Any circular dependency across layers

## Layer A (Core/Blocks) boundary

Typical paths:
- `src/blocks/**`
- `src/runtime/**`
- core state/persistence primitives in `src/orchestration/**`

Must contain:
- deterministic state transition logic
- queueing/scheduling primitives
- storage/persistence truth
- low-level tool/runtime primitives

Must NOT contain:
- channel-specific formatting
- UX-specific throttling/wording/presentation logic
- project/business policy branching that belongs to orchestration

## Layer B (Orchestration/App) boundary

Typical paths:
- `src/serverx/**`, `src/server/**`
- policy orchestration in `src/orchestration/**`
- role-policy glue in `src/agents/**`

Must contain:
- workflow composition and dispatch policy
- restart/recovery decisions from persisted lifecycle
- context rebuild policy and relevance strategy

Must NOT contain:
- persistence truth duplication (should call Layer A)
- channel UI rendering concerns

## Layer C (Delivery/Consumer) boundary

Typical paths:
- `src/ui/**`
- channel output/bridge presentation adapters

Must contain:
- rendering/sanitization/format adaptation
- progress presentation strategy

Must NOT contain:
- core dispatch/lifecycle correctness decisions
- blocking dependencies that gate core completion

## Critical invariant: Core never blocked by consumer

If Layer C fails (format, channel push, notification), system behavior MUST be:
1. Persist core result/lifecycle first
2. Emit error status for consumer failure
3. Continue core flow / recovery rules without deadlock

## Review quick checks

- Is the change in the owning layer?
- Does it introduce reverse dependency?
- Can a consumer failure block a core state transition?
- Can stale events regress terminal state?
