# AGENTS.md - Global Generic Constraints

This file defines generic collaboration and code-change constraints for the repository scope.
It intentionally avoids project-specific architecture, API, roadmap, and business details.

## Scope and Priority
- Applies to this directory tree.
- More deeply nested `AGENTS.md` files override this file in their subtrees.
- Direct user/developer/system instructions always take priority.

## Change Principles
- Make minimal, targeted changes that solve the root cause.
- Keep style consistent with existing code.
- Do not refactor unrelated areas unless explicitly requested.
- Do not revert user changes you did not make.

## Code Quality
- Prefer clear names and straightforward logic over cleverness.
- Avoid duplicate implementations; reuse existing abstractions where practical.
- Keep files reasonably small and cohesive.
- Add comments only for non-obvious logic.

## Safety and Hygiene
- Do not commit secrets, credentials, or private keys.
- Do not add build artifacts, temporary files, or coverage outputs.
- Avoid destructive git/file operations unless explicitly requested.

## Validation
- Validate changed behavior with the smallest relevant checks first.
- Expand to broader tests/builds only as needed.
- If validation cannot be run, state that clearly in handoff.

## Documentation
- Update docs when behavior, interfaces, or workflows change.
- Keep documentation concise, accurate, and implementation-agnostic where possible.
- Use one canonical docs directory naming convention per repo (choose `Docs/` or `docs/` and keep it consistent).

## 三层架构铁律（强制）
- 代码必须严格三层：`blocks`（基础能力层）/ `orchestration app`（编排层）/ `ui`（呈现层）。
- `blocks` 只提供基础能力与通用机制，不承载业务流程逻辑；它是全局唯一真源（Single Source of Truth）。
- `orchestration app` 只做 block 的组合、调度与流程编排，不承载业务规则本体。
- `ui` 只负责展示与交互，不承载业务编排逻辑；必须与业务实现解耦。
- 任何新增需求都应优先下沉到 `blocks` 抽象，避免在编排层或 UI 层复制业务语义。
