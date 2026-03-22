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

## 配置唯一真源原则
- 用户配置（AI provider、用户偏好）只读 `~/.finger/config/user-settings.json`，不得在其他文件（如 config.json）重复存储。
- 系统配置（orchestration.json、channels.json 等）各自独立，每个配置文件全局只有一个。
- 所有代码必须通过 `src/core/user-settings.ts` 提供的函数读取 AI provider 配置，禁止直接读取 config.json 的 kernel.providers。

## Agent Conduct & Accountability
- 所有结论必须基于可验证证据（文件内容/命令输出/测试结果），不得“推测已完成”。
- 未完成必须明确说明原因与阻塞点，严禁隐瞒或虚报进度。
- 未经用户明确允许，不删除仓库文件。
- 发现未跟踪文件时优先 review，再决定是否纳入；禁止默认清理/回退。
- 禁止执行进程终止类命令（如 `kill`/`pkill`/`killall` 等）。
- 代码逻辑必须精确处理问题，不得用兜底/后备/替代分支绕过，除非用户明确要求。
- 如果没有必要，需要自己进行查询和搜索，自己进行最佳线路规划和执行，不要做无意义的暂停和询问，尽量进行思考后直接执行。

## Memsearch 使用原则
1. 当任务完成或阶段性完成、有重要发现、或需要记录失败尝试时，使用 memsearch flow skill 进行记录。
2. 当需要压缩记忆时，使用 memsearch flow skill 进行记录。
3. 当有 debug 任务需要分析或有新任务要实现时，先使用 memsearch flow skill 做记忆搜索再执行。
4. 对用户反复要求的任务、习惯与命令，提炼规律并记录到 memsearch。
5. 当用户提出“请记住 / 记住 / 保存记忆 / 记忆一下”等请求时，必须调用 memsearch flow skill 写入记忆。
6. 当用户提出“查询记忆 / 查找记忆 / 搜索记忆 / 回忆”等请求时，先调用 memsearch flow skill 检索记忆，再进行代码搜索或实现操作。
7. 记忆只写入仓库根目录 `MEMORY.md`，按 Long-term / Short-term 分区维护；不要再使用 `memory/` 目录记录零散记忆。
8. 长期记忆只追加不删除；短期记忆在 review 通过后压缩归档到长期记忆。

## Validation
- Validate changed behavior with the smallest relevant checks first.
- Expand to broader tests/builds only as needed.
- If validation cannot be run, state that clearly in handoff.

## Debugging Principles
- 遇到通信/链路问题时，先用最小请求（如 curl）确认最底层请求/响应是否正常，再逐层向上定位（gateway → server → agent → tool），避免跳过底层验证。

## Documentation
- Update docs when behavior, interfaces, or workflows change.
- Keep documentation concise, accurate, and implementation-agnostic where possible.
- Use one canonical docs directory naming convention per repo (choose `Docs/` or `docs/` and keep it consistent).

## Project Operational Files (Do Not Delete)
- `HEARTBEAT.md`：项目级 heartbeat 巡检唯一真源。用于定义当前 heartbeat 要持续跟踪的 epic / 子任务、每轮巡检步骤、状态矩阵、巡检日志、关闭 heartbeat 的条件。
- `DELIVERY.md`：项目级交付与 reviewer 队列唯一真源。heartbeat / 人工巡检在确认某个任务闭环后，必须追加写入此文件，请 reviewer 基于这里的证据进行 review。
- 这两个文件属于项目运行中的操作文件，即使被 `.gitignore` 忽略，也**不得删除**；如果缺失，应先重建再继续执行。
- 对 heartbeat / review / 巡检类任务，必须优先读取这两个文件，再决定下一步动作。

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
2. 监听 UDP 端口（默认 9998）接收主程序心跳
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

## 新增安全与架构原则（2026-03-09）

### 文件操作安全
- 遇到没碰过但是修改的文件不主动删除，必须询问用户确认
- 使用 `git reset`、`pkill`、`killall` 等有严重后果的指令前必须先询问用户

### 代码架构原则
- 代码遵循共用函数化、模块化、自包含的原则
- 严格遵从三层架构：编排和功能不耦合
- `blocks` 是基础能力层的唯一真源
- `orchestration` 只做编排不做业务逻辑
- `ui` 只负责展示不与业务耦合

## 统一日志规范（强制）

### 核心原则

- **所有模块必须接入日志系统**：禁止使用 `console.log`、`console.error` 等直接输出。
- **唯一真源**：所有日志必须通过 `src/core/logger` 的 `FingerLogger` 输出。
- **结构化日志**：日志必须是结构化的 JSON 格式，便于查询和分析。
- **快照模式**：关键流程支持快照，记录完整执行上下文。

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

// 快照模式（关键流程）
const traceId = log.startTrace();
log.info('开始处理请求', { traceId });
// ... 执行逻辑 ...
log.endTrace(traceId);  // 自动写入快照文件
```

### 必须接入日志的核心模块

| 模块路径 | 模块名 | 关键日志点 |
|----------|--------|-----------|
| `src/blocks/agent-runtime-block/` | `AgentRuntimeBlock` | dispatch创建/执行/完成、错误处理 |
| `src/orchestration/message-hub.ts` | `MessageHub` | 消息路由、output调用 |
| `src/server/routes/message.ts` | `message-route` | 请求接收、session决策、响应返回 |
| `src/runtime/runtime-facade.ts` | `RuntimeFacade` | kernel请求/响应 |
| `src/server/modules/heartbeat-scheduler.ts` | `HeartbeatScheduler` | 心跳触发、dispatch状态 |
| `src/server/modules/system-agent-manager.ts` | `SystemAgentManager` | 系统agent生命周期 |
| `src/agents/finger-*/` | 各agent模块 | agent执行过程 |
| `src/gateway/` | `GatewayManager` | 网关请求路由 |

### 关键流程日志点

#### 消息处理流程（必须）

```
[message-route] Request received -> {messageId, target, sessionId}
[message-route] Session decision -> {action: 'reuse'|'new', sessionId}
[MessageHub] Routing to module -> {moduleId, routeId}
[AgentRuntimeBlock] Dispatching task -> {dispatchId, sourceAgentId, targetAgentId}
[AgentRuntimeBlock] Execute dispatch start -> {dispatchId, moduleId}
[RuntimeFacade] Kernel request -> {provider, model, tokenCount}
[RuntimeFacade] Kernel response -> {status, tokenCount, latency}
[AgentRuntimeBlock] Execute dispatch complete -> {dispatchId, status}
[message-route] Response sent -> {messageId, status}
```

#### Dispatch执行流程（必须）

```
[AgentRuntimeBlock] dispatchTask called -> {sourceAgentId, targetAgentId, sessionId}
[AgentRuntimeBlock] Deployment resolved -> {deploymentId, moduleId, status}
[AgentRuntimeBlock] Module lookup -> {moduleId, found: boolean}
[AgentRuntimeBlock] Queue decision -> {action: 'execute'|'queue', capacity, activeCount}
[AgentRuntimeBlock] executeDispatch start -> {dispatchId, targetModuleId}
[AgentRuntimeBlock] Module.run() called -> {dispatchId, moduleId}
[AgentRuntimeBlock] Module.run() result -> {dispatchId, status, duration}
[AgentRuntimeBlock] dispatchTask complete -> {dispatchId, ok, status}
```

### 日志配置

配置文件位置：`~/.finger/config/logging.json`

```json
{
  "globalLevel": "info",
  "moduleLevels": {
    "AgentRuntimeBlock": "debug",
    "MessageHub": "debug",
    "message-route": "debug"
  },
  "snapshotMode": false,
  "snapshotModules": []
}
```

### 禁止事项

- **禁止**使用 `console.log`、`console.error`、`console.warn`
- **禁止**在生产代码中直接写入文件输出日志
- **禁止**在日志中记录敏感信息（密码、token等）
- **禁止**在循环中高频打日志（使用采样或聚合）

### 新增代码检查项

代码审查时必须检查：
1. 所有新模块是否接入日志系统
2. 关键路径是否有足够的日志覆盖
3. 错误处理路径是否有日志
4. 是否有残留的 `console.*` 调用
