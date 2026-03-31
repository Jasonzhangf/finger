# Stop-Tool Turn Closure (Application-Layer Control)

## Goal

Move end-turn control from implicit `finish_reason=stop` to an application-layer explicit signal.

Core rule:

- `finish_reason=stop` is a **reference signal**, not the final authority.
- When stop-gate is enabled, a turn is considered truly closed only when the model has called `reasoning.stop`.

This keeps lifecycle control deterministic and configurable.

---

## Configuration (single strategy tuning only)

Policy file:

- `~/.finger/config/stop-reasoning-policy.json`

Fields:

- `requireToolForStop` (boolean): persisted for compatibility; runtime always enforces `true`
- `promptInjectionEnabled` (boolean): inject stop-control instructions into system prompt
- `stopToolNames` (string[]): allowed stop tools (default `reasoning.stop`)
- `maxAutoContinueTurns` (number): max local auto-continue retries when stop tool missing

Runtime admin tool:

- `reasoning.stop_policy`
  - `action=status|set`

Default behavior:

- stop-gate is always enabled (single strategy)

---

## Runtime tools

### 1) Stop tool

- Tool name: `reasoning.stop`
- Intent: explicit request to close current reasoning segment
- Required input: `summary`
- Optional: `status`, `task`, `nextAction`

### 2) Policy tool

- Tool name: `reasoning.stop_policy`
- Intent: query/update stop-gate tuning options only (`status` / `set`)
- Note: gate enable/disable is **not supported** in runtime (always enabled)

---

## Lifecycle behavior

### A. Prompt layer

When stop-gate is enabled and stop tool is available in current tool list,
runtime appends a control block into system prompt:

- if task complete: call stop tool first
- if task incomplete: continue execution, do not call stop tool
- stop without tool -> runtime continues automatically

### B. KernelAgentBase continuation

In `main` mode, after normal reply shaping:

1. detect if turn ended with `finish_reason=stop`
2. check whether stop tool evidence exists in `tool_trace`
3. if missing and gate enabled -> inject continuation prompt and rerun (`maxAutoContinueTurns` bounded)

This prevents “promise/stop/early-end” from being treated as final closure.

### C. Event-forwarding finalization gate

On loop events:

- track per-session whether stop tool was called during current turn
- for `turn_complete` with `finish_reason=stop`:
  - if gate enabled and stop tool missing:
    - lifecycle -> `interrupted / turn_stop_tool_pending`
    - skip `finalizeTransientLedgerMode`
    - skip channel end-turn finalize
    - keep observers/session stream alive
  - otherwise: normal finalize path

This avoids user seeing premature “本轮推理已结束。” then continued execution.

---

## Error management

1. **Missing stop tool under gate**
   - classification: non-terminal closure hold
   - action: continue execution (bounded local retries + scheduler-level recovery)

2. **Tool call parse ambiguity**
   - evidence source is `tool_call/tool_trace`
   - no text-based guess for closure

3. **Policy file malformed / missing**
   - fallback to safe defaults
   - no hard crash

4. **Continuation retry exhaustion**
   - keep lifecycle non-closed (not falsely completed)
   - rely on watchdog/next task loop for recovery continuation

---

## ASCII flow

```text
User request
   |
   v
Kernel runTurn
   |
   +--> finish_reason != stop ----------------------> continue normal lifecycle
   |
   +--> finish_reason == stop
            |
            v
      stop-gate enabled?
         |             |
        no            yes
         |             |
         v             v
   finalize path   stop tool called in this turn?
                      |                 |
                     yes               no
                      |                 |
                      v                 v
               finalize path     hold finalize + continue run
                                 (interrupted/turn_stop_tool_pending)
```

---

## Files touched

- `src/common/stop-reasoning-policy.ts`
- `src/tools/internal/stop-reasoning-tool.ts`
- `src/tools/internal/index.ts`
- `src/agents/chat-codex/agent-role-config.ts`
- `src/agents/base/kernel-agent-base.ts`
- `src/server/modules/event-forwarding.ts`

---

## Validation

- type-check: `pnpm -s tsc --noEmit`
- targeted tests:
  - `tests/unit/agents/kernel-agent-base.test.ts`
  - `tests/modules/event-forwarding.test.ts`
  - `tests/unit/server/agent-status-subscriber-session-utils.test.ts`
  - `tests/unit/common/stop-reasoning-policy.test.ts`
  - `tests/unit/tools/internal/stop-reasoning-tool.test.ts`
