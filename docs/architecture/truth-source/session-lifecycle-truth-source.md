# Session 生命周期与持久化真源

> 本文档是 Finger 项目「Session 生命周期、持久化、恢复与通知」的唯一设计真源。
> 任何相关代码改动必须与本文档保持一致。
> 
> 创建时间：2026-04-11
> 最后更新：2026-04-11

---

## 一、问题梳理（证据链）

### 问题 1：Daemon 重启后 Project Agent 未恢复执行

**现象**：旧 daemon 在 10:23 启动，执行了 Mirror 任务（hypatia/mempalace 调研），10:38 还在发送进度报告。新 daemon 10:39 启动后，project agent 没有恢复执行。

**根因**：`finger-project-agent/main.json` 的 `activeWorkflows: []` 和 `messages: []` 均为空。
- `saveSession()` 只在创建 session 时写入 `activeWorkflows: []`
- `activeWorkflows` 在 dispatch 时有 `addActiveWorkflow()` 调用（L1670），但 **workflow 完成时没有持久化记录**
- SessionManager `loadSessions()` 恢复后，`autoResume` 选最近的 session，但 `activeWorkflows` 为空导致 recovery 条件不满足

**代码证据**：
- `src/orchestration/session-manager.ts` L424: `saveSession()` 只更新 `updatedAt`、`messages`、`sessionProjection`、`activeWorkflows` 的 normalize
- `src/orchestration/session-manager.ts` L637/685/778: 所有 `createSession` 路径都写 `activeWorkflows: []`
- `src/serverx/modules/system-agent-manager.impl.ts` L370: `if (!lifecycle && !taskStateNeedsResume) return;` — lifecycle 读不到就跳过 recovery

### 问题 2：通知消息过长，手机通道不友好

**现象**：日志中最长进度报告 1064 字符，包含所有工具调用、上下文构成、轮次历史，拼接成一个超长 JSON payload。

**根因**：`buildCompactSummary()`（`src/server/modules/progress-monitor-reporting.ts`）把所有信息拼成一个大字符串，通过一条消息推送。

**代码证据**：
- `src/server/modules/progress-monitor-reporting.ts` L285-320: 拼接 context breakdown、tools、control tags 为一个长字符串
- `src/serverx/modules/progress-monitor.impl.ts` L1040: `summary: [heartbeatSummary, ...roundLines].join('\n')` — 单行推送

### 问题 3：轮次显示未完全移除

**现象**：重启前的日志仍包含 `🕘 最近轮次:` 段，带有 `✅ ✅ update_plan` 等重复轮次信息。

**根因**：`roundLines` 在 L1033 和 L1174 处虽然改了空数组，但旧代码仍在运行。

---

## 二、Session 生命周期（唯一真源）

### 2.1 存储位置

| 类型 | 路径 | 说明 |
|------|------|------|
| Session 元数据 | `~/.finger/sessions/{project}/{role}/main.json` | 唯一元数据真源 |
| Context Ledger | `~/.finger/sessions/{project}/{role}/context-ledger.jsonl` | append-only 事件流 |
| Compact Memory | `~/.finger/sessions/{project}/{role}/compact-memory.jsonl` | 压缩摘要 |
| Full Memory | `~/.finger/sessions/{project}/{role}/full-memory.jsonl` | 未使用 |

### 2.2 Session 目录映射

```
~/.finger/sessions/
├── _Volumes_extension_code_finger/           # 按项目路径映射的目录
│   ├── session-finger-project-agent/
│   │   └── main.json                         # 元数据 + 指针
│   └── session-review-{id}/
│       └── main.json
├── finger-project-agent/                     # 按角色命名的目录
│   └── main/                                 # 数据目录
│       ├── context-ledger.jsonl              # 实际事件流（3MB）
│       ├── compact-memory.jsonl
│       └── full-memory.jsonl
├── finger-system-agent/
│   └── main/
│       ├── context-ledger.jsonl
│       └── compact-memory.jsonl
└── review-{id}/
    └── finger-system-agent/
```

**映射规则**：
- `SESSIONS_DIR = ~/.finger/sessions` — 角色目录
- `SYSTEM_SESSIONS_DIR = ~/.finger/sessions` — 同一路径，按子目录区分
- 项目路径映射：`SESSIONS_DIR/{path_hash}/session-{session_id}/main.json`

### 2.3 Session 创建与加载

#### 创建路径（代码真源）

```
createSession() — L620 (role-based)
  → projectPath 写入 metadata + projectPath 字段
  → activeWorkflows: []
  → messages: []
  → context: { memoryOwnerWorkerId, ownerAgentId }
  → saveSession()

findOrCreateSessionByProject() — L660
  → 按 projectPath 精确匹配
  → 不存在则 createSession()

ensureSystemSession() — L770
  → 按 system agent 角色保证唯一
```

#### 加载路径（启动恢复）

```
SessionManager constructor — L65
  → loadSessions({ autoResume: true })
    → loadSessionsFromDir(SESSIONS_DIR)          # 角色目录
    → loadSessionsFromDir(SYSTEM_SESSIONS_DIR)   # 系统目录
    → loadSessionFile(filePath)                  # 逐个解析 main.json
    → cleanupEmptySessionsAcrossProjects()
    → 按 lastAccessedAt 排序，autoResume 最近一个
```

#### loadSessionFile 逻辑 — L196

```typescript
private loadSessionFile(filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const session = JSON.parse(content);
  
  // 1. 校验必要字段
  // 2. 迁移兼容（旧格式 -> 新格式）
  // 3. this.sessions.set(session.id, session)
  // 4. this.updateSessionProjectionState(session)
  // 5. saveSession(session) — 持久化归一化后的结果
}
```

### 2.4 运行时持久化点

| 触发时机 | 持久化内容 | 代码位置 |
|----------|------------|----------|
| Session 创建 | 完整元数据 | L655 `saveSession()` |
| Dispatch 绑定 | `activeWorkflows.push()` | L1670 `addActiveWorkflow()` |
| Dispatch 完成 | `activeWorkflows` 不变（**缺失**） | 无 |
| 消息追加 | Ledger append-only | `appendLedgerEntry()` |
| Context compaction | `compact-memory.jsonl` | Context Builder |
| Session 关闭 | 更新 `status` | `closeSession()` |

**关键缺失**：Dispatch 完成时 `activeWorkflows` 没有被清理或更新。这是 recovery 失效的根因之一。

---

## 三、Recovery 机制（唯一真源）

### 3.1 Recovery 触发条件

```
startup recovery 决策树：
1. lifecycle = getExecutionLifecycleState(sessionManager, sessionId)
2. inflight = detectInFlightKernelTurn(sessionId)
3. taskState = resolveActionableProjectTaskStateForRecovery(sessionId)

判断：
- 如果 !lifecycle && !taskStateNeedsResume → 跳过（当前问题！）
- 如果 lifecycleNeedsResume = shouldResumeLifecycle(lifecycle) && stage != 'completed'
- 如果 staleCompletedReason = detectStaleCompletedLifecycleForMonitoredProject()
- 如果 workerRecovery = resolveWorkerRecoveryPlan(taskState)

满足任一 → 构建恢复 prompt → dispatch 给 project agent
```

### 3.2 shouldResumeLifecycle 逻辑

```typescript
private shouldResumeLifecycle(lifecycle: ExecutionLifecycleState): boolean {
  if (finishReason === 'stop') return false;           // 正常完成
  if (lifecycle.stage === 'completed') return false;   // 已完成
  if (substage === 'turn_stop_tool_pending') return true;
  if (ACTIVE_LIFECYCLE_STAGES.has(lifecycle.stage)) return true;
  return lifecycle.stage === 'failed';                  // 失败也要恢复
}
```

### 3.3 Recovery 缺失环节

**问题**：`finger-project-agent/main.json` 的 `activeWorkflows` 为空 → `lifecycle` 读不到 → recovery 跳过。

**修复方向**：
1. **Dispatch 时记录**：dispatch 创建时，将 `workflowId` 写入 `activeWorkflows`（已有 L1670）
2. **Dispatch 完成时保留**：完成时**不**清理 `activeWorkflows`，而是更新状态（in_progress/needs_resume）
3. **Lifecycle 持久化**：`getExecutionLifecycleState` 需要从 ledger 中读取最后的状态快照，而不是仅从内存
4. **Project path 绑定**：`main.json` 必须包含 `projectPath`（已有），用于 startup 时扫描匹配

### 3.4 Recovery Prompt 模板

```
系统重启恢复：{恢复原因}
项目路径：{projectPath}
状态：{lifecycle.stage}/{lifecycle.substage}
请从当前中断点继续执行，直到任务真正完成（finish_reason=stop）。
```

---

## 四、进度报告设计（唯一真源）

### 4.1 报告生成流程

```
ProgressMonitor.tick (每 60s)
  → generateProgressReport()
    → activeProgress = filter(status === 'running' || recentlyActive)
    → for each session:
      → buildReportKey() — 去重键
      → findPendingMeaningfulTool() — 待执行工具
      → resolveWaitLayer() — 状态分层
      → buildCompactSummary() — 报告正文
      → deliverProgressReport() — 推送
```

### 4.2 通知消息分块规则

**手机通道友好原则**：
1. **每条消息 ≤ 300 字符**（约 100 中文字）
2. **分块推送**：状态块 + 上下文块 + 工具块
3. **精确去重**：同一 reportKey 不重复推送
4. **无轮次占位**：`roundLines = []`
5. **终态不报告**：lifecycleFinalState = true 时停止

**分块格式**：

```
块 1（状态）：
📊 {时间} | {状态}
🧭 当前工具 → {成功/失败/执行中}

块 2（上下文，仅变化时）：
🧠 上下文: {使用率} · {已用}/{总量}

块 3（工具进展，仅新增时）：
✅ [{工具名}] {简要结果}
⏳ [{工具名}] 执行中...
```

### 4.3 去重机制

```
去重键：buildReportKey(p) = 
  status|currentTask|latestStepSummary|recentTools|latestReasoning|context...

规则：
- lastReportKey === reportKey → 跳过（除非有新工具或未报告超时）
- hasUnreportedTools && enoughSinceLastReport → 推送
- stalled && shouldEmitHeartbeat → 推送心跳
```

---

## 五、修复计划

### 5.1 Session 持久化修复

| 序号 | 修复点 | 文件 | 说明 |
|------|--------|------|------|
| 1 | `saveSession` 必须持久化 `activeWorkflows` | session-manager.ts | 已有，但 workflow 完成时未更新 |
| 2 | `addActiveWorkflow` 持久化 | session-manager.ts | 已有 L1670，但调用时机需确认 |
| 3 | `clearActiveWorkflow` 或 `updateActiveWorkflow` | session-manager.ts | **缺失** — dispatch 完成时需要更新 |
| 4 | `lifecycle` 状态持久化 | execution-lifecycle.ts | 需要写入 session 元数据 |

### 5.2 通知分块修复

| 序号 | 修复点 | 文件 | 说明 |
|------|--------|------|------|
| 1 | 拆分 `buildCompactSummary` | progress-monitor-reporting.ts | 返回分块数组 |
| 2 | `deliverProgressReport` 支持分块 | progress-monitor.impl.ts | 多块独立推送 |
| 3 | 移除轮次显示 | progress-monitor.impl.ts | `roundLines = []` 已改 |
| 4 | 手机通道长度限制 | progress-monitor.config.ts | 新增 `maxChunkChars` 配置 |

### 5.3 Recovery 修复

| 序号 | 修复点 | 文件 | 说明 |
|------|--------|------|------|
| 1 | `getExecutionLifecycleState` 从 ledger 恢复 | execution-lifecycle.ts | 读取最后一条 lifecycle 事件 |
| 2 | `shouldResumeLifecycle` 增加 project 路径检查 | system-agent-manager.impl.ts | 扫描项目目录找活跃 session |
| 3 | Recovery prompt 包含 context 快��� | system-agent-manager.impl.ts | 从 ledger 恢复最后上下文 |
