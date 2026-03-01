# Chat-Codex Prompt Contract (V1)

## Scope

This document defines the prompt and request-construction contract for chat-codex based agents.

## 1) System/Base Prompt

- Source: `src/agents/chat-codex/prompt.md` (fallback in `coding-cli-system-prompt.ts`).
- Transport: `request.instructions`.
- Rule: fixed base prompt, no role-specific dynamic mutation.

## 2) Developer Prompt (role-specific)

- Source files:
  - `src/agents/chat-codex/dev-prompts/orchestrator.md`
  - `src/agents/chat-codex/dev-prompts/reviewer.md`
  - `src/agents/chat-codex/dev-prompts/executor.md`
  - `src/agents/chat-codex/dev-prompts/searcher.md`
- Transport: `input[]` entry with `role=developer` and `<developer_instructions>` block.
- Rule: role differences are expressed only in developer zone templates.
- Orchestrator role additionally allows plan/doc artifact edits via `apply_patch` + `update_plan`.
- Reviewer role enforces claim-evidence audit for executor outputs and practical planning-improvement feedback for orchestrator outputs.
- Reviewer supports review levels: `feedback` / `soft_gate` / `hard_gate`.

## 3) User-Meta + Conversation Partition

- `user_instructions` and `environment_context` are injected into `input[]` as `role=user` context blocks.
- Normal chat/tool history remains conversation zone.
- Initial injection order:
  1. developer_instructions
  2. turn_context
  3. user_instructions
  4. environment_context
  5. current user input

## 4) Structured Response Contract

- Output schema presets are defined in:
  - `src/agents/chat-codex/response-output-schemas.ts`
- Activation policy:
  - default: no strict output schema
  - explicit schema: `metadata.responsesOutputSchema` (highest priority)
  - preset: `metadata.responsesOutputSchemaPreset`
  - role default: `metadata.responsesStructuredOutput=true`

## 5) Request Construction Mapping

- JS side (chat-codex module) builds kernel user-turn options:
  - `system_prompt`
  - `developer_instructions`
  - `user_instructions`
  - `environment_context`
  - `responses.text.output_schema` (when enabled)
- Rust side injects blocks and builds Responses payload:
  - `instructions` from `system_prompt`
  - `input[]` from history + context blocks + current user input
  - `text.format` with json schema when `output_schema` is provided

## 6) Validation

### TS unit

- `tests/unit/agents/chat-codex-module.test.ts`
  - system prompt stability across roles
  - role-specific developer instructions with ledger block
  - structured schema disabled by default
  - role-default structured schema when enabled
  - explicit schema override precedence

### Rust unit

- `rust/kernel-model/src/lib.rs`
  - context partition into developer/user blocks
- `rust/kernel-model/src/protocol/request.rs`
  - responses payload and json schema mapping
