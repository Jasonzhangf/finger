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
- 提交规则：
- 已完成的修改直接提交。
- 不了解的修改需 review 后再提交。
- 临时文件、敏感文件、日志、构建产物不要提交。

## Agent Conduct & Accountability
- 所有结论必须基于可验证证据（文件内容/命令输出/测试结果），不得“推测已完成”。
- 未完成必须明确说明原因与阻塞点，严禁隐瞒或虚报进度。
- 未经用户明确允许，不删除仓库文件。
- 发现未跟踪文件时优先 review，再决定是否纳入；禁止默认清理/回退。
- 禁止执行进程终止类命令（如 `kill`/`pkill`/`killall` 等）。

## Validation
- Validate changed behavior with the smallest relevant checks first.
- Expand to broader tests/builds only as needed.
- If validation cannot be run, state that clearly in handoff.

## Documentation
- Update docs when behavior, interfaces, or workflows change.
- Keep documentation concise, accurate, and implementation-agnostic where possible.
- Use one canonical docs directory naming convention per repo (choose `Docs/` or `docs/` and keep it consistent).

## Task Tracking (bd)
- 任务/计划/依赖统一用 `bd --no-db` 管理，不在 `AGENTS.md` 写 TODO。
- 新需求先创建/更新 bd issue，包含清晰验收标准。
- 常用命令：
  - `bd --no-db ready`
  - `bd --no-db show <id>`
  - `bd --no-db create "Title" --type epic|task --parent <epic>`
  - `bd --no-db update <id> --status in_progress|blocked|closed`
  - `bd --no-db dep add <blocked> <blocker>`
  - `bd --no-db epic status`
- `.beads/issues.jsonl` 是唯一可版本化的 bd 数据文件；不要手改 JSONL，使用 `bd` 命令。
- 冲突处理：优先 `bd resolve-conflicts`，再继续提交。

## LSP 管理
- 需要代码语义分析时，必须启动 LSP：`lsp server start <repo_root>`。
- 结束前用 `lsp server list` 检查并 `lsp server stop <repo_root>` 清理。

## 三层架构铁律（强制）
- 代码必须严格三层：`blocks`（基础能力层）/ `orchestration app`（编排层）/ `ui`（呈现层）。
- `blocks` 只提供基础能力与通用机制，不承载业务流程逻辑；它是全局唯一真源（Single Source of Truth）。
- `orchestration app` 只做 block 的组合、调度与流程编排，不承载业务规则本体。
- `ui` 只负责展示与交互，不承载业务编排逻辑；必须与业务实现解耦。
- 任何新增需求都应优先下沉到 `blocks` 抽象，避免在编排层或 UI 层复制业务语义。
