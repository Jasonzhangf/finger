# Agent Protocol Module

## Purpose
Defines the canonical communication schema between orchestrator and executor agents.

## Exports
- `AgentMessage`
- `TaskAssignment`
- `ExecutionFeedback`
- `ToolAssignment`
- `createMessage()`

## ReACT Mapping
- `thought` → reasoning step
- `action` → dispatched work
- `observation` → execution feedback

## Tests
- Unit: `tests/unit/agents/protocol-schema.test.ts`
- Regression: include this test in CI (`npm run test`)
