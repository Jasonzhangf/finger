# Agent Runtime Module

## Purpose
Agent runtime and communication infrastructure.

## Exports
- `MessageBus` - EventBus wrapper for agent messaging

## Architecture
```
OrchestratorRole → MessageBus → EventBusBlock
                          ↓
                    ExecutorRole
```

## Tests
- `tests/unit/agents/message-bus.test.ts`

## Status
All tests passing, 51/51.
