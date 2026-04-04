# Finger Change Checklist

## Task
- Goal:
- Owning layer (A/B/C):
- Root cause hypothesis:

## Invariants to protect
- [ ] Core runtime forward progress not blocked by consumer/delivery failures
- [ ] Restart semantics stay correct (no stale in-flight continuation after restart)
- [ ] Terminal lifecycle cannot regress from stale/out-of-order events
- [ ] No silent failure path introduced

## Implementation
- Files changed:
- Why these files own the fix:
- Why this is root-cause (not workaround):

## Validation
- [ ] Targeted tests:
- [ ] `npx tsc --noEmit`
- [ ] `npm run test:session-regression` (if lifecycle/session/dispatch touched)
- [ ] `npm run build:backend` (for runtime changes)

## Evidence
- Key logs / outputs:
- Remaining risks / corner cases:
- Follow-up tasks (if any):
