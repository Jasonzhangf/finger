# Context Partition Rules

## Goal

Define a stable 4-zone prompt/input partition for the kernel request path:

1. System/Base zone (`request.instructions`)
2. Developer zone (`input[]`, `role=developer`)
3. User-Meta zone (`input[]`, `role=user`, meta blocks)
4. Conversation zone (normal user/assistant/tool history)

This document is the canonical rule for context partitioning in this repo.

## Fixed Rules

1. System prompt is fixed and not dynamically mutated per role/turn.
2. Agent role differences must be expressed in Developer zone templates.
3. Base agents include: `orchestrator`, `reviewer`, `executor`, `searcher`.
4. Ledger guidance belongs to Developer zone (not System zone toggles).

## Zone Responsibilities

### 1) System/Base

- Transport field: `request.instructions`.
- Source: base system prompt only.
- Constraints:
  - No role-specific dynamic append.
  - No runtime ledger guidance injection.
  - No AGENTS/environment/user meta content.

### 2) Developer

- Transport field: `input[]` with `role=developer`.
- Contains:
  - role template (fixed file by role)
  - developer instructions and execution hints
  - collaboration/model switch hints
  - turn context block
  - ledger policy block
- Role templates (fixed independent files):
  - `src/agents/chat-codex/dev-prompts/orchestrator.md`
  - `src/agents/chat-codex/dev-prompts/reviewer.md`
  - `src/agents/chat-codex/dev-prompts/executor.md`
  - `src/agents/chat-codex/dev-prompts/searcher.md`

### 3) User-Meta

- Transport field: `input[]` with `role=user`.
- Contains:
  - AGENTS/user instructions block
  - environment context block
- Must not be put into `request.instructions`.

### 4) Conversation

- Transport field: `input[]` history user/assistant + tool call/result history.
- Includes ongoing turn content and compacted historical summary.
- Compact pipeline must filter initial meta blocks (`developer_instructions`, `user_instructions`, `environment_context`, `turn_context`) from summary artifacts.

## Injection Order (first-turn common)

1. `developer_instructions` (developer)
2. `turn_context` (developer)
3. `user_instructions` (user-meta)
4. `environment_context` (user-meta)
5. current user input

## Architecture Boundary

- `blocks`: foundational capabilities and reusable primitives only (no business process logic).
- `orchestration app`: compose blocks only (no business logic source duplication).
- `ui`: presentation and interaction only, fully decoupled from business logic.

