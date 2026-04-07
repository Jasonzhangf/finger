---
name: finger dev skills
description: Project development guardrails for Finger. Defines layered architecture, module ownership, core-priority invariants, mandatory change/testing workflow, and multi-agent collaboration patterns. Use for any design, refactor, debug, or feature work in this repo.
---

# Finger Dev Skills

## 0) Intent

This skill is the project-local execution contract for Finger engineering work.

## 0.1) Mandatory Testing Hierarchy (MUST)

Every code change MUST be validated through a complete testing hierarchy before claiming completion. No feature is "done" without passing all relevant test levels.

### Testing Levels (Required by Change Scope)

| Change Scope | Required Tests | Coverage Threshold |
|---|---|---|
| **Single function/utility** | Unit tests | ≥90% branch coverage |
| **Module/class** | Unit + integration tests | ≥80% path coverage |
| **Cross-module interaction** | Integration + orchestration tests | Critical paths covered |
| **API endpoint/external interface** | Unit + integration + E2E | Full request/response cycle |
| **New feature/workflow** | Unit + integration + E2E + regression | All user paths + edge cases |
| **Performance-sensitive code** | All above + stress/benchmark | Latency + throughput bounds |
| **Lifecycle/daemon/process** | All above + longevity tests | Restart + recovery + timeout |

### Test Categories (Must Cover)

1. **Unit tests** (`tests/unit/**/*.test.ts`)
   - Pure function behavior
   - Input validation and error handling
   - Edge cases (null, empty, overflow, negative)
   - State transitions

2. **Integration tests** (`tests/integration/**/*.test.ts`)
   - Module-to-module interaction
   - Real filesystem/network where applicable
   - Mocked external services
   - Error propagation chains

3. **Orchestration tests** (`tests/orchestration/**/*.test.ts`)
   - Workflow composition correctness
   - Dispatch/recovery semantics
   - Lifecycle state machine transitions
   - Cross-agent coordination

4. **E2E tests** (`tests/e2e/**/*.test.ts`, `tests/e2e-ui/**/*.test.ts`)
   - Full system startup/shutdown
   - Real user interaction flows
   - Daemon + agent + kernel + channel end-to-end
   - Timeout and failure recovery in real conditions

5. **Regression tests**
   - Previously fixed bugs must have test guard
   - Each GitHub issue fix must include test case
   - Historical failure modes covered

6. **Stress/Load tests** (when applicable)
   - Concurrent request handling
   - Resource exhaustion scenarios
   - Memory/CPU bounds
   - Long-running process stability

### Pre-Commit Checklist (MANDATORY)

Before any commit that changes runtime behavior:

```bash
# 1. Run changed module unit tests
pnpm vitest run tests/unit/<module-path>/*.test.ts

# 2. Run integration tests for affected layers
pnpm vitest run tests/integration/<layer>/*.test.ts

# 3. Run full test suite if touching core/shared code
pnpm vitest run

# 4. Verify build succeeds
pnpm run build:backend

# 5. For E2E-level changes, run smoke E2E
pnpm vitest run tests/e2e/smoke/*.test.ts
```

### Evidence Requirements

- **No test = no merge.** Uncommitted code without tests is incomplete work.
- **Test output must be captured.** Include test run results in completion report.
- **Coverage gaps must be documented.** If a test level is skipped, explain why and risk.
- **Edge cases are not optional.** Timeout, failure, restart, overflow, null handling must be tested.

### Testing Anti-patterns (PROHIBITED)

- **"It is too hard to test"** → Refactor to make testable, or write integration/E2E test
- **"Manual testing is enough"** → Not for production code; automate the manual flow
- **"Tests would take too long"** → Write minimal critical-path tests first, expand later
- **"I will add tests later"** → Later never comes; tests are part of the change, not afterthought
- **"The code is simple"** → Simple code has simple bugs; write simple tests
- **"Mock everything"** → Integration/E2E must use real paths; mocks are for unit layer only

### Skill Update Rule

When a new testing pattern/requirement emerges from debugging or review:
1. Document the failure mode and test gap
2. Add test case to appropriate test file
3. Update this skill checklist if pattern is reusable


Use this skill whenever you touch architecture, core runtime, orchestration, dispatch/recovery, context rebuild, progress/reporting, or cross-agent collaboration logic.

## 1) Non-negotiable priorities (MUST)

1. **Core runtime forward progress is P0.**
   - Consumer/presentation layers must never block core execution.
   - If consumer side fails, core still progresses and persists state.

2. **No silent failure.**
   - Any failure in dispatch, lifecycle update, progress emit, hook, or persistence must be observable (status + reason + evidence).

3. **Restart semantics are strict.**
   - Non-restart path: in-process continuation is allowed within bounded policy.
   - Post-restart path: never pretend to continue stale in-flight kernel state; recover via persisted lifecycle truth.

4. **Root-cause fixes only.**
   - No workaround-only patches.
   - No “looks-fixed” response without code-path evidence and tests.

5. **Layer contracts are hard constraints.**
   - Put behavior in the correct layer; do not leak business logic upward/downward.

6. **Feature-level failures must be observable and non-blocking by default.**
   - For optional features and auxiliary paths (skill loading, parsing helpers, side-channel callbacks, preview/index helpers), failure handling must be:
     1) log structured error context,
     2) skip/degrade safely,
     3) keep core flow progressing.
   - Do not convert feature-level read/parse failures into hard-stop unless explicitly required by product semantics.

7. **No rollback-first debugging.**
   - Default strategy is forward root-cause fix with evidence.
   - Never use rollback/revert as the first-line “solution” for unknown behavior.
   - Rollback is an explicit exception path requiring user approval and clear risk statement.

8. **Worker-owned session/memory model is mandatory.**
   - Session ownership must be explicit (`memoryOwnerWorkerId`) and deterministic.
   - Scope keys are visibility filters, not ownership transfer.
   - Cross-agent read is allowed; cross-worker write/execute is forbidden.
   - Legacy session data must be backfilled/migrated idempotently.

## 2) Layer model and ownership

Reference: `references/layer-boundaries.md`.

### Layer A — Core/Blocks (truth layer)
- Paths (main): `src/blocks/**`, `src/runtime/**`, `src/orchestration/session-manager*`, core lifecycle primitives.
- Responsibility:
  - deterministic state transitions
  - persistence truth
  - queue/scheduler primitives
  - tool execution primitives
- Rule: no channel/UI-specific behavior here.

### Layer B — Orchestration/App (policy layer)
- Paths (main): `src/serverx/**`, `src/server/**`, `src/orchestration/**`, `src/agents/**` (role policy / workflow decisions).
- Responsibility:
  - compose blocks into workflows
  - dispatch/recovery policy
  - context rebuild policy
  - control block + stop gate policy wiring
- Rule: do not violate core invariants.

### Layer C — Delivery/Consumer (presentation layer)
- Paths (main): `src/ui/**`, channel bridge outputs, user-facing formatting/sanitization.
- Responsibility:
  - render progress
  - sanitize output
  - channel-specific UX
- Rule: failures here cannot block Layer A/B completion.

## 3) Skeleton design requirements

1. Every task must have explicit lifecycle:
   - `received -> dispatching/running -> waiting_* -> completed|failed|interrupted`
2. Terminal state cannot be regressed by stale/out-of-order events.
3. Session mapping must be deterministic by scope (system/project). V3: reviewer scope merged into system.
4. Heartbeat/control sessions are isolated from normal user sessions.
5. Persist-before-consume for critical state transitions.
6. Session ownership must survive restart/reload (ownership migration is startup-safe and idempotent).

## 4) Mandatory change workflow

1. **Classify scope first**
   - Which layer owns the change? (A/B/C)
   - Which invariant can be broken if wrong?

2. **Define acceptance before coding**
   - Expected lifecycle transitions
   - Expected recovery behavior on restart
   - Expected observability (progress/error evidence)

3. **Implement minimal root-cause diff**
   - No broad unrelated refactor in same patch.

4. **Add/adjust regression tests in same change**
   - Include at least one failure-path or out-of-order/pathological case.

5. **Run verification stack**
   - Targeted tests for touched modules
   - Type check
   - session regression
   - backend build pipeline

6. **Deliver with evidence**
   - what changed
   - why root cause is fixed
   - test outputs
   - remaining risks/corner cases

 ## 5) Mandatory multi-layer test strategy (ENFORCED)

 Every feature or bugfix MUST be validated across ALL applicable test layers before being declared complete.
 Skipping any layer without explicit justification is a hard violation.

 ### Layer 1 — Unit tests (mandatory, no exceptions)
 Every new function, class method, error branch, and edge case must have a unit test:
 - Schema parsing: valid input, invalid input, missing fields, boundary values.
 - State transitions: every lifecycle path including failure and timeout.
 - Error handling: verify error messages, error types, side-effect rollback.
 - Edge cases: null/undefined/empty string/zero/negative/overflow.

 ### Layer 2 — Integration / functional tests (mandatory for cross-module features)
 When a feature spans multiple modules (tool + injector + facade), integration tests are required:
 - Module A output feeds Module B: verify the contract end-to-end.
 - Cross-module data flow: inject → dispatch → prompt composition.
 - Real subprocess execution where applicable (hook commands, shell spawning).
 - Persistence round-trip: create → persist → reload → verify.

 ### Layer 3 — Regression / orchestration tests (mandatory for lifecycle features)
 When a feature touches lifecycle, scheduling, or state machines:
 - Restart recovery: kill → reload → verify correct state resume.
 - Out-of-order events: stale events must not regress terminal state.
 - Concurrency: timer firing while another tick is running.
 - Retry / backoff: failure handling respects backoff limits.

 ### Layer 4 — Stress / boundary tests (mandatory for resource-management features)
 When a feature manages timers, processes, memory, or queues:
 - Concurrent timers firing simultaneously.
 - Hook output exceeding max_output_chars truncation.
 - Timeout enforcement (hook > timeout_ms must be killed).
 - Resource cleanup after failure (no zombie processes, no leaked timers).
 - Max limits (MAX_SYNC_SLEEP_MS, MAX_HOOK_TIMEOUT_MS, etc.).

 ### Layer 5 — E2E / daemon-level tests (mandatory for user-facing flows)
 When a feature is exposed to agents or end users:
 - Real daemon startup → tool call → verify response.
 - Real clock injector running → timer fires → hook executes → dispatch delivered.
 - Sleep async → clock timer created → wake injection arrives.
 - Cross-agent dispatch with real message routing.

 ### Execution order (MANDATORY)
 1. Write Layer 1 (unit) tests FIRST, alongside the implementation.
 2. Write Layer 2 (integration) tests for every cross-module boundary.
 3. Write Layer 3 (regression) tests for every lifecycle/state feature.
 4. Write Layer 4 (stress) tests for resource-managing features.
 5. Write Layer 5 (E2E) tests for user-facing flows.
 6. Run ALL layers before declaring the feature complete.
 7. If ANY layer fails, fix the issue and re-run ALL affected layers.

 ### Anti-pattern (FORBIDDEN)
 - Declaring a feature "done" with only happy-path unit tests.
 - Skipping integration tests because "the unit tests passed".
 - Skipping stress tests because "the values are small".
 - Skipping E2E tests because "it worked locally".
 - Writing tests after being reminded — tests must be written as part of the implementation, not as an afterthought.

 ### Fast gate (while iterating)
 - `npm test -- <target-test-files>`
 - `npx tsc --noEmit`

 ### Session/runtime gate (required for session/lifecycle/dispatch changes)
 - `npm run test:session-regression`

 ### Full backend gate (required before handoff for runtime changes)
 - `npm run build:backend`

 ## 6) Change checklist (copy into task execution)

Use template: `templates/change-checklist.md`.

Required pass criteria:
- [ ] Correct layer ownership
- [ ] Core non-blocking invariant preserved
- [ ] Restart/non-restart semantics validated
- [ ] Terminal lifecycle non-regression validated
- [ ] Failure observability validated
- [ ] Regression tests added/updated
- [ ] Verification commands passed

## 7) Anti-patterns (forbidden)

- Letting progress/reporting pipeline block core completion.
- Treating restart as if in-flight kernel execution is still live.
- Overwriting terminal lifecycle with stale event updates.
- Dispatch failure hidden as success or no-op.
- “Fixing” by adding fallback branches that bypass real constraints.
- Swallowing errors with empty `catch {}` / silent ignore on critical or semi-critical paths.
- Treating feature-level failures as either silent no-op or global hard-fail (both are wrong); use “log + skip + continue” unless the feature is mandatory.
- Rollback-first handling without completed diagnosis and explicit user approval.

## 7) Multi-Agent Collaboration Patterns (2026-04-06)

### Architecture
- **Two-level hierarchy**: System Agent → Project Agent (dispatch unchanged)
- **Project Agent internal**: LLM tool-driven collaboration (借鉴 Codex Rust)
- **AgentPath**: Layered paths `/root/project/explorer/worker-1`, supports relative `./child`, `../sibling`

### LLM Tools (6 tools)
- `agent.spawn`: Create child with role/history fork (FullHistory/LastNTurns/None)
- `agent.wait`: Block until child completes
- `agent.send_message`: Queue-only message (triggerTurn=false)
- `agent.followup_task`: Message with triggerTurn=true (immediate execution)
- `agent.close`: Release agent from registry
- `agent.list`: List agents with path_prefix filter

### Fork History Inheritance
- `FullHistory`: Copy entire conversation
- `LastNTurns`: Keep last N turns (default 5), truncate mid-turn not allowed
- `None`: Fresh start, no history

### CompletionWatcher Pattern
- Background polling of child status
- Auto-notify parent mailbox via `sendAgentCompletion`
- Trigger on final status: completed/errored/shutdown

### Key Files
- `src/common/agent-path.ts`: Layered path system
- `src/orchestration/agent-registry.ts`: Concurrency control + nickname allocation
- `src/orchestration/session-fork.ts`: History inheritance
- `src/orchestration/agent-collab-watcher.ts`: Completion watcher
- `src/tools/internal/agent-collab-tools.ts`: 6 LLM tools
- `src/blocks/mailbox-block/index.ts`: InterAgentCommunication + triggerTurn

### Testing Requirements
- Unit tests for each component (≥90% coverage)
- Integration tests for cross-module flows
- Orchestration tests for lifecycle/state transitions
- E2E tests for full collaboration scenarios

### Anti-patterns (FORBIDDEN)
- Cross-worker session write (must use owner-only)
- spawn without proper history fork mode
- missing triggerTurn distinction
- CompletionWatcher not started after spawn
- AgentPath relative resolution errors

## 8) Experience Lessons (2026-04-06)

### API Response Parsing: Don't Use Serialized Text Fields

**Problem**: OpenAI Responses API returns both `output_text` (serialized summary) and `output` (structured array). The `output_text` field includes ALL content types serialized as text, including tool calls formatted as `[tool_use id=...] name=...]`.

**Wrong approach**:
```rust
// ❌ Using output_text directly
let output_text = payload.get("output_text").as_str();  // Contains tool syntax!
```

**Correct approach** (参考 Codex upstream):
```rust
// ✅ Parse structured output array, filter by type
for item in payload.get("output").as_array() {
    if item.type == "message" {
        output_text = item.content
            .filter(c => c.type == "output_text")
            .map(c => c.text)
            .join("\n");
    }
    // function_call handled separately, not mixed into text
}
```

**Lesson**: 
- API convenience fields (`output_text`, `summary`, etc.) often serialize ALL content including control blocks
- Always parse structured arrays and filter by `type` field
- Tool call syntax should NEVER appear in user-facing channel output
- Defense-in-depth: fix at kernel layer + filter at channel layer

**Related files**:
- `rust/kernel-model/src/lib.rs`: `parse_responses_payload`
- `src/server/modules/agent-status-subscriber-text.ts`: `stripControlBlockForChannel`

### Defensive Filtering at Multiple Layers

When a bug affects user-facing output, apply fixes at BOTH:
1. **Root cause layer** (kernel/parser) - fix the actual parsing logic
2. **Output layer** (channel/delivery) - defensive regex filter as safety net

This ensures even if root cause slips through, the final output is clean.

### Scheduler Window Behavior: Don't Wake on Restart Outside Window

**Problem**: HeartbeatScheduler and DailySummaryScheduler were logging "started" and triggering immediate ticks on every server restart, even when outside the configured execution window (e.g., 0:00-7:00). This caused wasteful idle checks and log noise.

**Symptoms**:
- `Daily summary scheduler started` logged multiple times per restart
- Unnecessary tick() calls when no work exists
- Log spam: 808 duplicate "started" entries in one day

**Wrong approach**:
```typescript
// ❌ Always log "started" and run immediate tick
start(): void {
  this.logRuntime('Daily summary scheduler started', { ... });
  void this.tick(); // Runs even outside window!
}
```

**Correct approach**:
```typescript
// ✅ Check window first, only tick when in window
start(): void {
  const hour = new Date().getHours();
  const inWindow = isHourInWindow(hour, this.windowStartHour, this.windowEndHour);
  
  if (inWindow) {
    this.logRuntime('Scheduler started (in window)', { currentHour: hour });
    void this.tick();
  } else {
    log.debug('Scheduler ready (outside window)', { currentHour: hour });
    // No immediate tick, wait for window entry
  }
}
```

**Lesson**:
- Windowed schedulers should check `isHourInWindow()` before startup actions
- Immediate `tick()` only when actually in the execution window
- Outside window: silent startup, debug-level log only
- Prevents wasteful "no work to do" cycles on every restart

**Related files**:
- `src/server/modules/daily-summary-scheduler.ts`: start()
- `src/serverx/modules/heartbeat-scheduler.impl.ts`: start()

## 9) 日志系统规范（强制）

### 核心原则

- **所有模块必须接入日志系统**：禁止使用 `console.log`、`console.error` 等直接输出
- **唯一真源**：所有日志必须通过 `src/core/logger` 的 `FingerLogger` 输出
- **结构化日志**：日志必须是结构化的 JSON 格式，便于查询和分析
- **Trace 模式**：关键流程支持 trace，记录完整执行上下文

### 日志系统使用

```typescript
import { logger } from '../core/logger.js';

// 每个模块创建独立的 ModuleLogger
const log = logger.module('ModuleName');

// 日志级别
log.debug('详细调试信息', { key: 'value' });
log.info('正常业务流程', { userId: 'xxx', action: 'login' });
log.warn('潜在问题', { reason: 'retry', attempt: 2 });
log.error('错误信息', error, { context: 'additional data' });
log.fatal('致命错误', error, { critical: true });

// Trace 模式（关键流程）
const traceId = log.startTrace();
log.info('开始处理请求', { traceId });
// ... 执行逻辑 ...
log.endTrace(traceId);  // 自动写入快照文件
```

### Trace 链路完整覆盖（2026-04-06）

关键路径已全部接入 trace 模式：

```
dispatchTask → executeDispatch → sendToModule → callTool
```

| 模块 | Trace 功能 | 关键日志点 |
|------|-----------|-----------|
| `AgentRuntimeBlock.dispatchTask` | ✅ startTrace + endTrace 包裹 | dispatch 入口 + 早期返回 |
| `AgentRuntimeBlock.executeDispatch` | ✅ traceId 参数传递 | blocking/non-blocking 分支 |
| `AgentRuntimeBlock.toDispatchPayload` | ✅ metadata.traceId | payload 写入 traceId |
| `AgentRuntimeBlock.drainDispatchQueue` | ✅ 独立 trace | queued dispatch 独立上下文 |
| `MessageHub.sendToModule` | ✅ 提取 traceId + debug log | routing to output/input |
| `RuntimeFacade.callTool` | ✅ 提取 traceId + info/error log | tool_call/result/error |

### 配置位置

`~/.finger/config/logging.json`:
```json
{
  "globalLevel": "info",
  "moduleLevels": {
    "AgentRuntimeBlock": "debug",
    "MessageHub": "debug",
    "RuntimeFacade": "debug",
    "CompletionWatcher": "debug"
  },
  "snapshotMode": true,
  "snapshotModules": ["AgentRuntimeBlock", "MessageHub", "RuntimeFacade"]
}
```

### Trace 输出路径

- **实时日志**: `~/.finger/logs/daemon.log`（搜索 `[traceId=xxx]`）
- **快照文件**: `~/.finger/logs/snapshots/<traceId>.json`（完整生命周期）

### 使用方式（问题回溯）

1. 从 `daemon.log` 搜索 `[traceId=xxx]`
2. 查找对应 `snapshots/xxx.json`（完整 trace 生命周期）
3. Trace 覆盖完整 dispatch → execute → sendToModule → callTool 链路

### Scheduler 窗口行为优化

- **DailySummaryScheduler**: `start()` 检查 `isHourInWindow()`，非窗口期不触发 `tick()`
- **HeartbeatScheduler**: 同样逻辑，避免非窗口期重复启动
- **防止**: 非窗口期重复启动浪费 token

### 禁止事项（强制）

- **禁止**使用 `console.log`、`console.error`、`console.warn`（仅 `cli/init.ts` 和 `logger/index.ts` 允许）
- **禁止**在生产代码中直接写入文件输出日志
- **禁止**在日志中记录敏感信息（密码、token等）
- **禁止**在循环中高频打日志（使用采样或聚合）
- **禁止**缺失 `data` context 在关键路径日志

### Console.* 检查结果（合规）

- `logger/index.ts`: 8 处（logger 失败时的 fallback，允许）
- `cli/init.ts`: 22 处（用户 CLI 输出，允许）
- 其他 runtime 文件: 0 处（已全部清理）


---

## Section 10: Context Compact 设计（2026-04-07）

### 核心原则（认知修正 2026-04-07）

1. **Deterministic Digest**：不调用 LLM，直接截断 + 提取工具调用
2. **预算管理**：contextHistory > 20K 时移除最旧的 digest
3. **Compact 与 Rebuild 是同一操作**（关键认知修正）:
   - ❌ 错误理解：compact 和 context rebuild 是两件事，先 compact 再想办法触发 rebuild
   - ✅ 正确理解：compact 的目的就是为了 rebuild context，它们是一个原子操作
   - compact：将 currentHistory 压缩成 digest，写入 compact-memory.jsonl
   - rebuild：基于新指针（contextHistory + currentHistory）重建上下文窗口
   - **必须在同一函数内完成**，确保 Kernel 拿到重建后的上下文

### Compact 完整流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Turn-level Digest（finish_reason = stop）                             │
├─────────────────────────────────────────────────────────────────────────┤
│   chat-codex-module.ts                                                   │
│   ├── finishReason === 'stop'                                            │
│   ├── controlBlock.tags → 模型打的 tags                                  │
│   ├── digestProvider(sessionId, digestMessage, tags, agentId, mode)      │
│   │   └── appendDigestForTurn → 写入 compact-memory.jsonl               │
│   └── digest_block { turn_digest: true, tags: [...] }                   │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ 2. Context Compact（85% 触发 或 手动触发）                                │
├─────────────────────────────────────────────────────────────────────────┤
│   RuntimeFacade.maybeAutoCompact / compressContext({ force: true })      │
│   ├── 读取 currentHistory（context-ledger.jsonl 窗口）                   │
│   ├── 生成 compact_block（多条消息压缩）                                  │
│   ├── 清空 currentHistory                                                 │
│   └── 预算管理（contextHistory > 20K 时移除最旧的）                       │
���─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ 3. Context Rebuild（Kernel 启动时）                                       │
├─────────────────────────────────────────────────────────────────────────┤
│   Kernel 读取：                                                           │
│   ├── compact-memory.jsonl [contextHistoryStart..End]                    │
│   ├── context-ledger.jsonl [currentHistoryStart..End]                    │
│   └── 合并 → 完整上下文（在预算内）                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 关键文件

| 文件 | 作用 |
|------|------|
| `context-history-compact.ts` | `appendDigestForTurn` / `compactSessionHistory` |
| `session-manager.ts` | `appendDigest` / `compressContext` |
| `runtime-facade.ts` | `maybeAutoCompact` / `compressContext` |
| `chat-codex-module.ts` | `digestProvider` 调用（finish_reason=stop） |

### 预算参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `CONTEXT_HISTORY_BUDGET` | 20000 | contextHistory 最大 tokens |
| `AUTO_CONTEXT_COMPACT_THRESHOLD_PERCENT` | 85 | 自动压缩触发阈值 |
| `AUTO_CONTEXT_COMPACT_COOLDOWN_MS` | 60000 | 自动压缩冷却时间 |
| `AUTO_CONTEXT_COMPACT_TIMEOUT_MS` | 30000 | 压缩超时时间 |

### 强制压缩

```typescript
// 手动触发强制压缩（忽略 threshold）
await runtime.compressContext(sessionId, { trigger: 'manual' });

// force=true 时跳过 threshold 检查
```

### 反模式

1. ❌ **不要在 compact 时调用 LLM**：使用 deterministic digest
2. ❌ **不要忘记 force 参数**：手动压缩时必须 force=true
3. ❌ **不要在 turn_digest 中包含 source_range**：只有 compact_block 才有
4. ❌ **不要把 compact 和 rebuild 分开**：compact 完成后必须立即 rebuild，它们是同一操作的两个阶段
5. ❌ **不要期望 Kernel 自动获取新上下文**：compact 后必须主动调用 context_builder.rebuild 或返回新上下文给 Kernel

---

## Section 11: 铁律与强制规范

### 1. 全局编译安装（强制）

**每次修改代码后必须执行全局编译安装，不能用本地版本**：

```bash
npm run build:install
npm run daemon:start
```

**禁止**：
- ❌ 直接运行 `node dist/server/index.js`（本地版本）
- ❌ 跳过 `build:install` 步骤

**原因**：全局安装的版本才是生产环境使用的版本，本地 dist 可能与全局版本不一致。

---

### 2. 系统消息前缀规范

**通知来源区分**：

| 来源 | 前缀 | 示例 |
|------|------|------|
| **系统自动发送** | `[system]` | `[system] Daemon 已启动` |
| **Agent 推理回复** | `{AgentName}:` | `SystemBot: E2E mailbox ping 已收到` |

**判断标准**：
- 系统自动发送：不需要 agent 推理，代码直接执行
- Agent 推理回复：需要 agent 调用 kernel 推理后生成

**示例**：
```
[system] HeartbeatScheduler 已启动
[system] Mailbox ping 成功：latency=2ms
SystemBot: 收到，处理中…
SystemBot: E2E mailbox ping 已收到。通路正常，无待办。
```

---

### 3. Mailbox Ping 两层机制

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 链路层 Ping (Dry-Run) - 肌肉记忆                          │
├─────────────────────────────────────────────────────────────┤
│ - 频率：每轮心跳                                              │
│ - 方式：底层直接读取 mailbox 状态                             │
│ - Agent 无感知：不 dispatch，不通知                           │
│ - 日志：Debug 级别，避免打爆日志                              │
│ - 前缀：无（用户看不到）                                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 2. 真实 Mailbox Check - 有任务才 dispatch                     │
├─────────────────────────────────────────────────────────────┤
│ - 条件：pending > 0 + agent 空闲 + 到了检查时间               │
│ - 方式：dispatch 真实任务给 agent                            │
│ - 前缀：`SystemBot:` (agent 推理回复)                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 3. E2E 测试 - 定期验证（每周）                                │
├─────────────────────────────────────────────────────────────┤
│ - 条件：距离上次 E2E 测试 >= 7 天                            │
│ - 方式：dispatch 真实业务任务给 agent                        │
│ - 前缀：`SystemBot:` (agent 推理回复)                        │
└─────────────────────────────────────────────────────────────┘
```

**关键文件**：
- `src/server/modules/heartbeat-mailbox-ping.ts` - 底层 ping 函数
- `src/server/modules/heartbeat-helpers.ts` - 集成 ping dry-run

---

### 4. 进度更新去重优化

**改进点**：
- `buildReportKey` 移除文件路径（避免相同类型的工具调用被认为是不同的）
- `extractToolDetail` 截断到 80 字符（避免过长导致视觉重复）
- `LOW_VALUE_TOOLS` 包含 `mailbox.status/list/read/ack`（不在进度更新中显示）

---

### 5. Context Compact 设计（完整）

```
┌─────────────────────────────────────────────────────────────┐
│ Session 结构                                                 │
├─────────────────────────────────────────────────────────────┤
│ contextHistory (compact-memory.jsonl)                       │
│ - 预算：20,000 tokens                                       │
│ - 移除策略：超过 20K 时移除最旧的 digest                     │
│                                                              │
│ currentHistory (context-ledger.jsonl)                       │
│ - 无限制（可以无限增长）                                      │
│ - 触发压缩条件：contextUsagePercent >= 85%                  │
└────────────────��────────────────────────────────────────────┘

Compact 触发时机：
1. finish_reason=stop 时自动生成 digest（每轮）
2. contextUsagePercent >= 85% 时自动压缩
3. 手动命令：<##@system:compact##>
```

**关键文件**：
- `src/runtime/context-history-compact.ts` - 确定性 digest 生成
- `src/server/modules/heartbeat-mailbox-ping.ts` - 链路层 ping

## Section 11: 内存管理红线（Memory Redlines）

### 核心原则

**所有内存中的数据结构必须有硬上限**。防止内存泄露导致进程OOM。

---

### 禁止事项

1. **禁止无上限的 Map/Set**
   ```typescript
   // ❌ 错误：无限增长的 Map
   const cache = new Map<string, Data>();
   
   // ✅ 正确：有硬上限 + TTL 清理
   const cache = new Map<string, { data: Data; ts: number }>();
   const MAX_ENTRIES = 1000;
   const TTL_MS = 10 * 60 * 1000; // 10 分钟
   
   // 定期清理
   setInterval(() => {
     for (const [k, v] of cache.entries()) {
       if (Date.now() - v.ts > TTL_MS) cache.delete(k);
     }
     // 硬上限：超过 MAX_ENTRIES 删除最旧的 10%
     if (cache.size > MAX_ENTRIES) {
       const keys = Array.from(cache.keys()).slice(0, Math.floor(MAX_ENTRIES * 0.1));
       for (const k of keys) cache.delete(k);
     }
   }, TTL_MS);
   ```

2. **禁止全量读取大文件**
   ```typescript
   // ❌ 错误：50MB 文件全量加载
   const content = await fs.readFile(ledgerPath, 'utf-8');
   const entries = content.split('\n').map(JSON.parse);
   
   // ✅ 正确：流式读取或按需读取
   // 方案 A：tail -n 读取最后 N 行
   // 方案 B：使用 readline 逐行读取
   ```

3. **禁止在内存中持有完整的上下文历史**
   - Session.messages 必须是快照（projection），不是全量历史
   - 全量历史存储在 Ledger（磁盘）
   - 内存中的 Session 只保留指针或最近 N 条

---

### 硬上限参数

| 数据结构 | 文件 | 上限 | TTL |
|---------|------|------|-----|
| `lastQueuedSystemDispatchPushByKey` | agent-status-subscriber-handlers.impl.ts | 无上限（TTL清理） | 10min |
| `dispatchLedgerDedup` | event-forwarding.impl.ts | 1000 | 10min |
| `controlHookActionDedup` | event-forwarding.impl.ts | 1000 | 10min |
| `sessionEnvelopeMap` | agent-status-subscriber.impl.ts | 无上限（TTL清理） | 配置项 |
| `sessions` Map | session-manager.ts | 无上限 | 需要添加 |

---

### 必须实施的清理机制

1. **TTL 清理**：定期删除过期的 key
2. **硬上限**：超过上限时删除最旧的 10%
3. **手动清理**：session 结束时主动 delete

---

### 相关文件

- `src/serverx/modules/agent-status-subscriber-handlers.impl.ts`
- `src/serverx/modules/event-forwarding.impl.ts`
- `src/orchestration/session-manager.ts`
- `src/serverx/modules/progress-monitor.impl.ts`
