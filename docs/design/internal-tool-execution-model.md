# Internal Tool Execution Model

## Purpose

This document defines the single-source-of-truth rule for Finger internal tools:

- **state tools**: structured, in-process, deterministic tool handlers
- **execution tools**: subprocess / PTY / command-runner wrappers

The goal is to prevent core truth/state tools from depending on CLI stdout/stderr transport.

## Rule

All `src/tools/internal/*` tools must declare:

```ts
executionModel: 'state' | 'execution'
```

### 1. `executionModel: "state"`

Use for tools that expose or mutate structured system truth:

- ledger / context history
- mailbox state
- heartbeat state
- permissions / approvals
- skills metadata
- context builder views
- memory/query/index structures
- plan state snapshots

Requirements:

- must execute **in-process**
- must return **structured objects**, not parse subprocess stdout
- must not depend on generic CLI bootstrapping
- must not rely on stdout text framing as the primary contract

Examples:

- `context_ledger.memory`
- `context_builder.rebuild`
- `mailbox.*`
- `heartbeat.*`
- `permission.*`
- `skills.*`
- `update_plan`

### 2. `executionModel: "execution"`

Use for tools whose business purpose is to execute external commands or interactive processes:

- shell commands
- PTY sessions
- stdin/stdout interaction
- external CLI capability wrappers
- external patch executors

Requirements:

- subprocess / PTY is expected
- stdout/stderr is part of the product contract
- result may be textual and command-shaped

Examples:

- `shell.exec`
- `shell`
- `exec_command`
- `write_stdin`
- `unified_exec`
- `apply_patch`
- `capability.*`

## Ledger-specific rule

`context_ledger.memory` is a **state tool** and must never depend on generic CLI stdout parsing.

Reason:

- ledger is part of the agent memory truth path
- parser pollution from unrelated module logs is unacceptable
- CLI boot side effects can change output framing and break retrieval

Implementation decision:

- internal tool path calls `executeContextLedgerMemory(...)` directly
- CLI runner remains only for manual/operator/debug usage

## Review checklist

When adding or reviewing an internal tool:

1. Is this tool exposing structured truth or mutating structured truth?
   - yes → `state`
2. Is this tool's job to run a command/process?
   - yes → `execution`
3. If it is `state`, does it still spawn a CLI or parse stdout?
   - if yes, redesign before merge
