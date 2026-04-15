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


---

## 2026-04-14: /dev/null 问题完整分析结论

### 问题回顾

用户发现 `/dev/null` 命令出现在正常会话的 progress 报告中，质疑：
1. `/dev/null` 是什么？为何要执行？
2. hb session 为何会混入正常 session？
3. 修复后是否清理了旧的污染？

### 完整分析

**Q1: `/dev/null` 是什么？为何要执行？**

`/dev/null` 不是被执行的文件，而是 shell 命令语法的一部分：
- `rg pattern file 2>/dev/null` → ripgrep 搜索，错误重定向
- `crontab -l >/dev/null` → 查看 crontab，输出重定向
- `cat file 2>/dev/null` → 读取文件，错误不显示
- `launchctl list 2>/dev/null` → 查看服务，错误重定向

这些命令是 finger-system-agent 执行的用户请求，不是心跳任务。

**Q2: hb session 为何会混入正常 session？**

根因：`isSystemSession()` 判断错误
- 使用 `projectPath === SYSTEM_PROJECT_PATH` 判断
- `dispatch-finger-project-agent-*` 的 projectPath 可能是 SYSTEM_PROJECT_PATH
- 导致 dispatch session 被错误识别为 System Session
- finger-system-agent 的所有操作（包括用户请求）都用这个错误的 session

**Q3: 修复后是否清理了旧的污染？**

修复内容：
1. 删除 `projectPath === SYSTEM_PROJECT_PATH` 的判断条件
2. 只依赖 `sessionTier === 'system'` 和 `sessionId.startsWith('system-')`
3. 删除旧的错误 session 目录

验证结果：
- ✅ System Session ID 格式正确：`system-*`（不再出现 `dispatch-*`）
- ✅ hb-session 没有 ledger（心跳任务隔离）
- ✅ 新 session 的命令来自用户请求（不是心跳任务）

### 最终结论

| 问题 | 状态 | 说明 |
|------|------|------|
| `/dev/null` 是什么 | ✅ 正常 | shell 命令语法，用户请求 |
| hb session 混入正常 session | ✅ 已修复 | `isSystemSession()` 判断正确 |
| dispatch session 被当作 System Session | ✅ 已修复 | 不再出现 `System session: dispatch-*` |
| Progress 报告显示 `/dev/null` | ✅ 正常 | digest 的 key_tools 摘要 |

### 规则总结

1. **System Session 判断**：只依赖 `sessionTier` 和 `sessionId`，禁止用 `projectPath`
2. **Session 类型隔离**：`system-*`、`hb-*`、`dispatch-*` 完全独立
3. **唯一真源原则**：Ledger 是唯一源，Session 是动态视图
4. **Progress 报告**：消费数据，不参与数据产生


## Control Hook Memory Patch
- idempotency_key: hb-session-finger-project-agent-finger-main|turn-1776222260700|hook.project.memory.update
- updated_at: 2026-04-15T03:04:20.798Z
- source_session: hb-session-finger-project-agent-finger-main
- source_turn: turn-1776222260700
- long_term: ledger 路径不存在时需查证实际 ledger 位置和覆盖范围，避免伪完成

## Control Hook Memory Patch
- idempotency_key: hb-session-finger-project-agent-finger-main|turn-1776222585405|hook.project.memory.update
- updated_at: 2026-04-15T03:09:45.501Z
- source_session: hb-session-finger-project-agent-finger-main
- source_turn: turn-1776222585405
- long_term: verify-ledger-existence-before-analysis

## Control Hook Memory Patch
- idempotency_key: hb-session-finger-project-agent-finger-main|turn-1776222763557|hook.project.memory.update
- updated_at: 2026-04-15T03:12:43.651Z
- source_session: hb-session-finger-project-agent-finger-main
- source_turn: turn-1776222763557
- long_term: Mailbox notification already processed in earlier turn; always verify output file existence before re-processing

## Control Hook Memory Patch
- idempotency_key: hb-session-finger-project-agent-finger-main|turn-1776223212198|hook.project.memory.update
- updated_at: 2026-04-15T03:20:12.252Z
- source_session: hb-session-finger-project-agent-finger-main
- source_turn: turn-1776223212198
- long_term: 指定时间范围与 ledger 实际时间戳需交叉验证

## Control Hook Memory Patch
- idempotency_key: hb-session-finger-project-agent-finger-main|turn-1776230225012|hook.project.memory.update
- updated_at: 2026-04-15T05:17:05.164Z
- source_session: hb-session-finger-project-agent-finger-main
- source_turn: turn-1776230225012
- long_term: Mailbox message IDs may be stale/expired when heartbeat tasks arrive. Always verify existence before claiming completion.

## Control Hook Memory Patch
- idempotency_key: hb-session-finger-project-agent-finger-main|turn-1776233503378|hook.project.memory.update
- updated_at: 2026-04-15T06:11:43.526Z
- source_session: hb-session-finger-project-agent-finger-main
- source_turn: turn-1776233503378
- long_term: ledger_sparse_report_factual_findings_without_fabrication

## Control Hook Memory Patch
- idempotency_key: hb-session-finger-project-agent-finger-main|turn-1776233567400|hook.project.memory.update
- updated_at: 2026-04-15T06:12:47.581Z
- source_session: hb-session-finger-project-agent-finger-main
- source_turn: turn-1776233567400
- long_term: mailbox messages may be auto-cleaned or consumed in previous turns

## Control Hook Memory Patch
- idempotency_key: hb-session-finger-project-agent-finger-main|turn-1776233624271|hook.project.memory.update
- updated_at: 2026-04-15T06:13:44.398Z
- source_session: hb-session-finger-project-agent-finger-main
- source_turn: turn-1776233624271
- long_term: Mailbox message IDs may be stale when enqueued from previous turns - always verify current mailbox state

## Control Hook Memory Patch
- idempotency_key: hb-session-finger-project-agent-finger-main|turn-1776234307394|hook.project.memory.update
- updated_at: 2026-04-15T06:25:07.481Z
- source_session: hb-session-finger-project-agent-finger-main
- source_turn: turn-1776234307394
- long_term: Mailbox task injection should validate message existence before triggering continuation

### 2026-04-15: Finger local skill 必须保持轻量单真源

**问题**：`.agents/skills/finger-dev-skills/SKILL.md` 演变成 handbook，重复 AGENTS 与设计文档，并残留过期路径/旧名。

**收口**：
- Skill 只保留：层级归属、唯一真源定位、最小验证矩阵、repo 特有高价值反模式
- `AGENTS.md` 继续作为硬护栏真源
- `docs/design/*.md` 继续作为子系统设计真源

**规则**：
- 本地 skill 必须是 execution adapter，不得扩张成 handbook
- 不得在 skill 中保存易过期静态事实（计数、临时路径、旧命名）
- context-history 对外唯一名保持 `context_history.rebuild`
