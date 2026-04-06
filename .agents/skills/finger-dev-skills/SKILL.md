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
3. Session mapping must be deterministic by scope (system/project/reviewer).
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

### 核心原则

1. **Deterministic Digest**：不调用 LLM，直接截断 + 提取工具调用
2. **预算管理**：contextHistory > 20K 时移除最旧的 digest
3. **两层分离**：
   - Turn-level Digest（finish_reason=stop 触发）
   - Context Compact（85% 触发 或 手动触发）

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
