# Historical Rationale (Non-Canonical)

> This document is historical rationale only.
> The only authoritative implementation contract is:
> `docs/design/project-task-lifecycle-state-machine.md`

# Ledger-Only Persistence + Dynamic Session Views 设计

> Last updated: 2026-03-26  
> Status: In Progress（finger-262.1 / 262.2 / 262.4 已落地，仍有收尾）  
> Owner: Jason

---

## 1. 背景

随着 context builder、task grouping、tag-aware ranking、embedding recall 的引入，原来的“session 文件 = 会话持久化真源”模型已经不再合适：

1. 真正长期有价值的数据已经全部进入 ledger；
2. 每轮模型所见上下文本质上是**动态重建结果**，不是对某个 session 文件的直接回放；
3. session 文件、session messages、ledger 三套概念同时存在，容易造成漂移、重复写入、恢复路径分叉；
4. 超出预算的历史并不应该强行塞进 prompt，而应该通过 ledger 工具按需检索。

因此，Finger 需要从“session 文件驱动”进一步收敛到：

> **Ledger-only persistence + dynamic session views**

即：
- **Ledger 是唯一持久化真源**
- **Session 只是逻辑 scope 与动态视图，不再承担消息持久化职责**

---

## 2. 核心决策

## 2.1 唯一持久化真源：Ledger

所有以下内容都只应以 ledger 形式持久化：

- user input
- assistant body
- reasoning
- tool_call / tool_result / tool_error
- dispatch / mailbox 生命周期
- compact summary
- embedding index / 其他派生索引

Ledger 是唯一事实来源；其他文件只允许是：
- cache
- snapshot
- debug artifact
- derived view

而不能再是独立真源。

---

## 2.2 Session 保留逻辑概念，不保留“持久化消息文件”概念

Session 仍然需要保留，但重新定义为：

### Session 的保留职责
- 作为 `sessionId` 的逻辑命名空间
- 用于 UI tab / channel observer / mailbox scope / root-child 关系绑定
- 用于限定“从哪段 ledger 范围重建本轮上下文”

### Session 不再承担的职责
- 不再作为消息持久化文件
- 不再作为历史上下文唯一恢复路径
- 不再作为模型输入的直接来源真源

一句话：

> **保留 sessionId，移除 session 文件作为持久化消息容器的地位。**

---

## 3. 新的上下文分区模型

模型每轮实际看到的上下文拆成两大区：

## 3.1 本轮推理区（Working Set）

这是强保真的当前工作集，优先级最高，原则上不做摘要替代。

包含：
- 当前用户输入
- 当前轮附件
- 当前轮 mailbox 提示
- 当前轮已产生的关键 tool result / dispatch result / reasoning
- 当前 task 直接相关的最近消息

### 约束
- Working Set 不参与“是否召回”的竞争
- 当前 task 必须稳定保留在上下文尾部
- 不能被历史排序或 embedding recall 稀释

---

## 3.2 历史记忆区（Historical Memory Zone）

这是预算受限的历史上下文区域，只包含“与当前任务最相关”的历史信息。

候选来源：
- ledger task blocks
- compact summaries
- tag/topic 命中
- embedding recall
- model rerank

### 约束
- 历史记忆区由 budget 控制
- 只注入预算内高价值内容
- 不保证完整覆盖全部历史

---

## 3.3 超预算历史（Overflow History）

超预算的历史不再强塞进 prompt，而是转为**可检索外存**。

访问方式：
- `context_ledger.memory search`
- `context_ledger.memory query`
- 未来可扩展的 hybrid recall / slot detail fetch

### 约束
- 模型不得假设“所有历史都已经在上下文里”
- 当前上下文缺证据时，必须主动调用 ledger 工具检索

---

## 4. Context Builder 的新职责

Context Builder 从“history 重排器”升级为：

> **动态会话视图构建器（Dynamic Session View Builder）**

每轮构建顺序：

### Step 1. 固定注入区（稳定注入，不参与历史重排）
- system prompt
- developer prompt
- skills
- mailbox baseline
- 当前 user input
- 当前 attachments

### Step 2. 本轮推理区
- 从 ledger 中提取当前轮及当前 task 的 working set
- 保持原始顺序与高保真内容

### Step 3. 历史记忆区
- 从 ledger task blocks / compact memory 中找历史候选
- 先做 embedding recall / tag hint / 其他候选筛选
- 再做模型排序（可选）
- 按 budget 注入

### Step 4. 超预算留外部
- 不再试图全注入
- 在提示词中明确要求模型用 `context_ledger.memory` 补查

---

## 5. 检索模型：从“全量历史注入”改为“召回 + 按需查询”

## 5.1 默认策略

默认不再追求“把所有相关历史都放进 prompt”，而是：

1. 当前 task Working Set 必保留
2. 历史区只注入 budget 内高相关记忆
3. 超预算部分走 ledger tool

## 5.2 召回优先级

历史候选可综合以下信号：
- tag/topic
- embedding semantic similarity
- recentness
- file/module overlap
- dispatch/mailbox lineage

## 5.3 工具检索闭环

当模型发现上下文证据不足时，应执行：

1. `context_ledger.memory search`
2. 根据返回的 slot / compact hint 再做
3. `context_ledger.memory query(detail=true, slot_start, slot_end)`

这条闭环要在提示词里明确写清楚。

---

## 6. Prompt / Skill 规则更新方向

系统提示词与 developer prompt 应明确增加以下认知：

### 6.1 上下文不等于完整历史
- 当前 prompt 中的历史内容只是 budget 内动态视图
- 不要把“当前没看到”误认为“历史不存在”

### 6.2 ledger 是唯一真源
- 真正完整历史在 ledger
- compact / embedding index 只是召回入口，不是最终证据

### 6.3 证据不足就检索
- 若当前问题依赖更早历史而上下文不足，优先调用 `context_ledger.memory`
- 不允许在缺证据时凭猜测续推

### 6.4 已完成的第一步实现（finger-262.2）
- system prompt / developer prompt / skill prompt / `context_ledger.memory` tool 描述都已补齐：
  - 当前上下文只是动态 budgeted view，不是完整历史
  - `working_set` 与 `historical_memory` 都只是 ledger 视图
  - 缺证据先 `search`，再 `query(detail=true, slot_start, slot_end)`
  - 不允许把“prompt 里没看到”当成“历史不存在”
- 这一步的目标是先把模型认知桥接补齐，后续再继续推进真正的 ledger-only persistence 收口。

### 6.5 已完成的第二步实现（finger-262.1）
- `context_ledger.memory` 已从“slot 查询工具”升级为更明确的 overflow-history 主入口：
  - `search` 除了 raw slot summaries / compact hits 外，还会返回 **task-block candidates**
  - 每个 task-block 都附带 `detail_query_hint`，可直接继续 `query(detail=true, slot_start, slot_end)`
  - 返回结果新增 `context_bridge`，明确说明这次检索扫描的是 full ledger，而不是当前 prompt 里的 budgeted view
- tool wrapper 也会自动注入当前 `session_id / agent_id` 到 `_runtime_context`，避免模型每次手填基础作用域。

### 6.6 已完成的第三步实现（finger-262.4）
- **Session 文件去真源化**（`src/orchestration/session-manager.ts`）：
  - 旧的“额外动态视图 / getLedgerView”路径已删除；
  - 运行时唯一历史快照改为 `Session.messages`；
  - `getMessages/getFullContext` 统一读取当前 session snapshot，不再额外拼一份 builder 视图；
  - `latestUserPrompt` 改为从 ledger 反查，不再读 `session.messages`；
  - `updateMessage/deleteMessage` 在 ledger-only 模式下禁用（append-only 原则）。
- **Server 路由与命令处理去 `session.messages` 依赖**：
  - `session.ts` 统一通过 `getSessionMessageSnapshot` / `getMessages` 返回会话消息计数与预览；
  - `messagehub-command-handler.ts` 的 session 列表、切换提示、system 列表均改为 ledger snapshot；
  - `ledger-routes.ts` 移除 `metadata.messages.length` fallback，messageCount 仅来自 ledger。
- **上下文构建桥接修复**（`finger-role-modules.ts`）：
  - Context builder 入参历史改为 `runtime.getMessages(sessionId, 0)`（ledger 动态视图）；
  - 媒体输入检测不再依赖 `session.messages`，同时识别 `attachments` 与 `metadata.attachments`。

---

## 7. 存储模型调整

## 7.1 保留
- `context-ledger.jsonl`
- `compact-memory.jsonl`
- 各类索引文件（如 `compact-memory-index.json`、`task-embedding-index.json`）

## 7.2 降级为派生/缓存
- session messages cache
- session snapshot
- prompt injection snapshot
- UI 组装态 session view

## 7.3 最终目标
- 不再依赖 session 文件恢复消息历史
- session 视图始终从 ledger 动态重建

---

## 8. 迁移路线

## Phase 1：语义与真源收敛
- 明确 session 文件不是消息真源
- 所有读取路径优先走 ledger reader / context builder
- 提示词写清 Working Set / Historical Memory / Overflow History

## Phase 2：移除 session 文件持久化依赖
- 盘点仍在直接读写 session messages 的路径
- 改为 ledger-only persistence
- session 元数据保留，但不持久化消息正文

## Phase 3：工具检索与上下文构建统一
- `context_ledger.memory` 接入 embedding hybrid search
- context builder 与工具检索使用相同的 recall/index 能力

## Phase 4：UI 真源统一
- UI 展示“动态 session view”
- 明确显示哪些来自 working set、哪些来自历史记忆区、哪些未注入需检索

---

## 9. 验收标准

- [x] 消息正文的唯一持久化来源是 ledger
- [x] session 文件不再作为历史消息真源
- [ ] context builder 产物明确分为本轮推理区 / 历史记忆区
- [x] 超预算历史可通过 `context_ledger.memory` 完整补查
- [x] 提示词明确声明“上下文不是完整历史，证据不足要检索 ledger”
- [ ] UI/监控层能区分当前 working set 与历史记忆区

---

## 10. 与现有设计的关系

- 本文是对 `docs/design/ledger-session-integration.md` 的进一步收敛：
  - 保留“ledger 是唯一真源”的原则
  - 进一步弱化 session 文件的持久化地位
- 本文与 `docs/design/context-history-rebuild-design.md` 配套：
  - `context-history-rebuild-design.md` 说明构建策略和模式
  - 本文说明为什么 session 应退化为动态视图，以及预算外历史如何通过 ledger tool 检索
