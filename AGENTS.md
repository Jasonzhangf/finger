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
- Fix root causes directly; do not use rollback/patching as a substitute for diagnosis.

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
- 日志/输出文件必须落盘到 `~/.finger`，不得写入仓库路径（例如 `logs/`、`output/`）。

## Agent Conduct & Accountability
- 所有结论必须基于可验证证据（文件内容/命令输出/测试结果），不得“推测已完成”。
- 未完成必须明确说明原因与阻塞点，严禁隐瞒或虚报进度。
- 未经用户明确允许，不删除仓库文件。
- 发现未跟踪文件时优先 review，再决定是否纳入；禁止默认清理/回退。
- 禁止执行进程终止类命令（如 `kill`/`pkill`/`killall` 等）。
- 禁止书面或口头使用 “fallback/后备/兜底/替代方案” 等表述。

## Validation
- Validate changed behavior with the smallest relevant checks first.
- Expand to broader tests/builds only as needed.
- If validation cannot be run, state that clearly in handoff.

## Documentation
- Update docs when behavior, interfaces, or workflows change.
- Keep documentation concise, accurate, and implementation-agnostic where possible.
- Use one canonical docs directory naming convention per repo (choose `Docs/` or `docs/` and keep it consistent).

## Testing Files
- `tests/modules/**/*.test.ts` (blocks 基础能力层)
- `tests/unit/blocks/**/*.test.ts` (blocks 基础能力层)
- `tests/orchestration/**/*.test.ts` (orchestration 编排层)
- `tests/unit/orchestration/**/*.test.ts` (orchestration 编排层)
- `tests/agents/**/*.test.ts` (agents 业务层)
- `tests/unit/agents/**/*.test.ts` (agents 业务层)
- `tests/api/**/*.test.ts` (API)
- `tests/integration/**/*.test.ts` (integration)
- `tests/e2e/**/*.spec.ts` (end-to-end)
- `tests/e2e-ui/contracts/**/*.test.ts` (UI contracts)
- `tests/e2e-ui/controls/**/*.test.ts` (UI controls)
- `tests/e2e-ui/flows/**/*.test.ts` (UI flows)
- `tests/e2e-ui/stability/**/*.test.ts` (UI stability)

## Task Tracking (bd)
- 任务/计划/依赖统一用 `bd --no-db` 管理，不在 `AGENTS.md` 写 TODO。
- 新需求先创建/更新 bd issue，包含清晰验收标准。
- 常用命令：
  - `bd --no-db ready`
  - `bd --no-db search "<keyword>"`
  - `bd --no-db list --status open|in_progress|blocked`
  - `bd --no-db show <id>`
  - `bd --no-db create "Title" --type epic|task --parent <epic>`
  - `bd --no-db update <id> --status in_progress|blocked|closed`
  - `bd --no-db update <id> --claim`
  - `bd --no-db dep add <blocked> <blocker>`
  - `bd --no-db epic status`
- `.beads/issues.jsonl` 是唯一可版本化的 bd 数据文件；不要手改 JSONL，使用 `bd` 命令。
- 冲突处理：优先 `bd resolve-conflicts`，再继续提交。

## LSP 管理
- 需要代码语义分析时，必须启动 LSP：`lsp server start <repo_root>`。
- 结束前用 `lsp server list` 检查并 `lsp server stop <repo_root>` 清理。
- 任何涉及跨文件重构或大范围引用分析的任务必须用 LSP 完成定位与引用核查。

## 三层架构铁律（强制）
- 代码必须严格三层：`blocks`（基础能力层）/ `orchestration app`（编排层）/ `ui`（呈现层）。
- `blocks` 只提供基础能力与通用机制，不承载业务流程逻辑；它是全局唯一真源（Single Source of Truth）。
- `orchestration app` 只做 block 的组合、调度与流程编排，不承载业务规则本体。
- `ui` 只负责展示与交互，不承载业务编排逻辑；必须与业务实现解耦。
- 任何新增需求都应优先下沉到 `blocks` 抽象，避免在编排层或 UI 层复制业务语义。

## 生命周期管理（强制）

### 设计原则

- **主程序主动退出**：主程序（Daemon/Server）负责生命周期管理，可主动退出。
- **子进程心跳依赖**：所有子线程/进程必须依赖主程序的心跳存活。
- **自杀机制**：子进程连续 **3 次** 未收到心跳（每次间隔 **30 秒**，共 **90 秒**）必须自杀。
- **UDP 广播心跳**：使用 UDP 广播机制，主程序定期广播，子进程监听。

### 心跳参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `HEARTBEAT_INTERVAL_MS` | 30000 | 心跳广播间隔（30 秒） |
| `MISSED_THRESHOLD` | 3 | 允许丢失的心跳次数 |
| `HEARTBEAT_TIMEOUT_MS` | 90000 | 心跳超时时间（3 × 30 秒） |

### 实现位置

- **心跳广播**：`src/agents/core/heartbeat-broker.ts` - `HeartbeatBroker`（主程序）
- **心跳监听**：`src/agents/core/heartbeat-broker.ts` - `HeartbeatMonitor`（子进程）
- **进程管理**：`src/daemon/process-manager/agent-process.ts` - `AgentProcess`
- **注册表**：`src/daemon/process-manager/process-registry.ts` - `ProcessRegistry`

### 子进程自杀流程

1. 子进程启动时创建 `HeartbeatMonitor` 实例
2. 监听 UDP 端口（默认 5522）接收主程序心跳
3. 每次收到心跳重置 `missedCount = 0`
4. 每 30 秒检查一次：`missedCount++`
5. 当 `missedCount >= 3` 时：
   - 记录日志：`[HeartbeatMonitor] Master appears dead, initiating self-destruct`
   - 停止监听器
   - 调用 `onDeath()` 回调（通常是 `process.exit(1)` 或清理后退出）

### 主程序退出流程

1. 主程序停止心跳广播：`heartbeatBroker.stop()`
2. 等待子进程自杀（最多 90 秒）
3. 强制清理残留进程（如有）
4. 主程序退出

### 验收标准

- [ ] 主程序退出后，所有子进程在 90 秒内自动退出
- [ ] 子进程日志包含 `Missed heartbeat X/3` 记录
- [ ] 子进程自杀前记录 `Master appears dead, initiating self-destruct`
- [ ] 无残留僵尸进程

### 边界情况

- **网络分区**：UDP 广播可能被防火墙阻止，子进程会自杀（预期行为）
- **主程序假死**：主程序未退出但停止广播，子进程同样会自杀（预期行为）
- **时钟漂移**：使用 `Date.now()` 计算间隔，不受系统时钟调整影响

## 测试文件规范

### 目录与命名

- 所有测试文件统一使用 `*.test.ts` 或 `*.test.tsx` 命名。
- 基础能力层（Blocks）：
  - `tests/modules/*.test.ts`
  - `tests/unit/blocks/**/*.test.ts`
- 编排层（Orchestration）：
  - `tests/orchestration/*.test.ts`
  - `tests/unit/orchestration/**/*.test.ts`
- Agent 层：
  - `tests/agents/*.test.ts`
  - `tests/unit/agents/**/*.test.ts`
- UI E2E（测试中心自动注册源）：
  - `tests/e2e-ui/contracts/**/*.test.ts`
  - `tests/e2e-ui/controls/elements/**/*.test.ts`
  - `tests/e2e-ui/controls/navigation/**/*.test.ts`
  - `tests/e2e-ui/controls/forms/**/*.test.ts`
  - `tests/e2e-ui/flows/**/*.test.ts`
  - `tests/e2e-ui/stability/**/*.test.ts`

### 结构约定

- `describe()` 作为测试套件（Suite）名称来源。
- `it()` 作为测试用例（Case）名称来源。
- 不在测试文件中执行副作用初始化（启动服务等），此类逻辑应由测试运行器负责。
