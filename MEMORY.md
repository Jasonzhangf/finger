# MEMORY.md - Finger Project Long-term Memory

## Long-term Memory (永久记忆)

### 2026-04-14: Session 类型隔离修复

**问题**：`/dev/null` 命令出现在正常会话的 progress 报告中

**根因**：
1. `isSystemSession()` 判断错误：使用 `projectPath === SYSTEM_PROJECT_PATH` 判断
2. `dispatch-finger-project-agent-c10f76b24ee25335` 的 `projectPath` = `/Users/fanzhang/.finger/system`
3. 导致 dispatch session 被错误识别为 System Session
4. finger-system-agent 的心跳任务命令混入正常会话

**修复**：
- 删除 `projectPath === SYSTEM_PROJECT_PATH` 的判断条件
- 只依赖 `sessionTier === 'system'` 和 `sessionId.startsWith('system-')`

**规则**：
- System Session：`system-{agentId}-{timestamp}`
- Heartbeat Session：`hb-session-{agentId}-{project}`
- Dispatch Session：`dispatch-{sourceAgentId}-{targetAgentId}-{timestamp}`
- **禁止用 `projectPath` 判断 session 类型**

**影响**：
- finger-system-agent 现在使用正确的 `system-*` session
- 心跳任务和正常会话完全隔离

---

### 2026-04-14: Context History Rebuild 统一路径

**问题**：payload 超限判断和 rebuild 触发在不同地方

**修复**：
- 统一判断路径：runtime-facade.ts（唯一判断点）
- 统一触发路径：runtime-facade.ts（唯一触发点）
- rebuild 只一次：如果还超限是设计问题

**规则**：
- **禁止 chat-codex-module 自己做 payload 判断和压缩**
- **禁止临时态（`_runtime_context.session_messages`）**
- **唯一真源**：sessionManager.getMessages() 或 contextHistoryProvider

---

### 2026-04-14: Developer Instructions 精简

**问题**：developer_instructions 和 system_prompt 有重复规范说明

**修复**：
- 移除重复的规范说明（Skills/Mailbox/USER.md/FLOW.md/AGENTS.md）
- 只保留具体内容（路径、文件内容、运行时数据）
- system_prompt 只保留"如何使用"规范

**规则**：
- system_prompt：规范说明（路由、分区作用）
- developer_instructions：具体内容（路径、文件、运行时数据）

---

### 2026-04-13: Checkout 必须确认

**问题**：agent 不确认就 checkout，撤销了用户的修改

**规则**：**永远不要不确认就 checkout**

---

## Short-term Memory (短期记忆)

### 当前任务

- finger-302: Context History Management 模块拆分
- finger-303: Rebuild 统一路径完整实现

### 待验证

- Progress 报告 recentRounds 是否还有旧数据
- 新 session 是否干净（没有 heartbeat 命令）

