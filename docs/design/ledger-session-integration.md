# Ledger-Session 一体化架构设计

> Last updated: 2026-03-23 17:03:00 +08:00
> Status: Approved（唯一真源，所有 Agent 必须遵循）
> Owner: Jason
>
> 相关场景文档：
> - `docs/design/system-project-ledger-lifecycle.md`（System ↔ Project 派发/回传/mailbox 生命周期）
> - `docs/design/ledger-only-dynamic-session-views.md`（Ledger-only persistence + dynamic session views 新收敛方向）

## 1. 核心原则

### 1.1 Ledger = 唯一数据真源
- **Ledger 是整个系统的唯一数据真源（Single Source of Truth）**
- 所有对话数据（用户输入、助手回复、工具调用、推理过程）只写入 Ledger
- Ledger 本质是**静态的上下文输入流水账**——记录了会话中发生的所有事件，不可修改、不可删除
- Session **没有自己的独立存储**，Session 的所有消息数据完全来自 Ledger 的动态拼接
- 写操作的唯一路径：LedgerWriter → context-ledger.jsonl（append-only）
- 不存在"先写 session 再同步 ledger"的流程，只存在"写 ledger → session 视图更新"

**Ledger 包含两个文件（二级记忆系统）**：
  - `context-ledger.jsonl`：**原始流水账**——完整记录所有事件（用户消息、助手回复、工具调用、推理、错误等），无限延展
  - `compact-memory.jsonl`：**压缩流水账**——压缩后的记忆摘要，同样只追加不修改，无限延展

### 1.1.1 Ledger 的不可变性原则
- Ledger 记录一旦写入，**永不可修改或删除**（append-only + immutable）
- 压缩不会修改原始记录，而是将压缩结果写入 compact-memory.jsonl 作为新的追加行
- Session 指针（originalStartIndex、originalEndIndex）只是"窗口游标"，指向 ledger 中的行号范围
- 任何读取 session 数据的操作，都必须通过 ledger 进行，不能绕过 ledger 直接读 session.messages

### 1.1.2 Session ID 与 Ledger Session ID 一致
- 每个 Ledger 文件对应一个 Session，两者共享相同的 Session ID
- Ledger 文件路径格式：`<sessions-root>/<session-id>/<agent-id>/main/context-ledger.jsonl`
- Session 元数据文件路径格式：`<sessions-root>/<session-id>/session.json`
- 通过 Session ID 可以直接定位到对应的 Ledger 文件

### 1.2 Session = 动态视图
- **Session 不是数据存储，而是 Ledger 数据的动态视图（View）**
- Session 的所有消息内容**完全从 Ledger 中拼接**，不存储任何消息数据本身
- Session 文件只存储**元数据**：ID、名称、项目路径、Ledger 指针（originalStartIndex、originalEndIndex、totalTokens）
- **缓存机制**：`_cachedView` 是 Ledger 视图的内存缓存，在 ledger 写入后自动失效
- **懒加载**：只在需要时（API 调用、模型请求）从 Ledger 重建 Session 视图
- **不可持久化消息**：Session.messages 数组只是向后兼容的临时缓存，不应作为数据来源

### 1.2.1 Session 动态构建流程
```
1. 读取 session.json 获取元数据（originalStartIndex、originalEndIndex、latestCompactIndex）
2. 读取 compact-memory.jsonl 中 latestCompactIndex 行（如果有），获取压缩摘要
3. 读取 context-ledger.jsonl 中 [originalStartIndex, originalEndIndex] 范围的原始记录
4. 拼接为 SessionView：compressedSummary + latestMessages
5. 缓存到 session._cachedView
6. 后续写入 ledger 后，清空 _cachedView 强制下次重建
```

### 1.2.2 读取数据的唯一正确路径
```typescript
// ✅ 正确：从 Ledger 读取（异步）
const messages = await sessionManager.getMessagesAsync(sessionId, limit);

// ❌ 错误：直接读 session.messages（可能为空或过期）
const messages = sessionManager.getMessages(sessionId, limit);  // 仅向后兼容

// ✅ API 层必须使用 getMessagesAsync
app.get('/api/v1/sessions/:sessionId/messages', async (req, res) => {
  const messages = await sessionManager.getMessagesAsync(sessionId, limit);
});
```

### 1.2.3 写入数据的唯一正确路径
```typescript
// ✅ 正确：写入 Ledger（原子操作）
await ledgerWriter.appendSessionMessage(context, role, content, { reasoning });

// 写入后 session 视图自动失效（_cachedView = undefined）
// 下次读取时会从 ledger 重新构建

// ❌ 错误：直接 push 到 session.messages
session.messages.push({ role, content });  // 这只是缓存同步，不是数据写入
```

### 1.3 压缩范围
- 压缩只取 ledger 指针范围内的数据，不处理整个 ledger
- 压缩生成两个输出：
  1. **消息摘要**：标准的内容压缩
  2. **用户偏好 patch**：提取用户偏好变化

### 1.4 反例约束（参考 codex rollout 限制）
- **禁止 Limited-only 持久化策略**：Finger 的 ledger 不采用“默认只落白名单事件”的模式。
- **禁止将关键事件归类为 None 后不落盘**：
  - 用户输入
  - 助手最终回复
  - 工具调用参数/结果（含失败）
  - 结构化结果（JSON/对象）
  - 推理链路中的关键决策事件
  上述事件均必须可追溯落盘。
- **禁止仅保留裁剪输出作为唯一真源**：
  - 显示层可使用 summary/preview（可裁剪）
  - 但 ledger 必须保存完整 raw payload（不可截断）
- **禁止丢弃 `Other`/未知结构响应**：未知类型必须原样入账（raw），后续再做解析。
- **流式 delta 策略**：允许 UI 侧聚合显示，但 ledger 至少要保留回合级完整结果与可回放关键片段，不能因 delta 过滤导致事实丢失。

---

## 2. 架构设计

### 2.0 概念关系图（Agent 必读）

```
┌──────────────────────────────────────────────────────────────────┐
│                     概念关系（唯一真源）                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────┐        ┌───────────────────────┐         │
│  │  Ledger（流水账） │        │  Session（动态视图）  │         │
│  │  ══════════════  │        │  ══════════════════  │         │
│  │                   │        │                       │         │
│  │  唯一数据真源     │──────▶│  从 Ledger 动态拼接  │         │
│  │  静态、不可变     │        │  内存中的缓存视图    │         │
│  │  append-only      │        │  可丢弃、可重建      │         │
│  │  持久化到磁盘     │        │  不持久化消息内容    │         │
│  │                   │        │                       │         │
│  │  ┌─────────────┐  │        │  指针 → Ledger 行号 │         │
│  │  │ 原始流水账 │  │        │  压缩摘要+最新消息 │         │
│  │  │ context-   │  │        │  = 发给模型的内容   │         │
│  │  │ ledger.jsonl│  │        │                       │         │
│  │  ├─────────────┤  │        └───────────────────────┘         │
│  │  │ 压缩流水账 │  │                                        │
│  │  │ compact-   │  │                                        │
│  │  │ memory.jsonl│  │                                        │
│  │  └─────────────┘  │                                        │
│  └───────────────────┘                                        │
│                                                                  │
│  关键规则：                                                     │
│  ① 所有写操作只写 Ledger，Session 视图从 Ledger 派生            │
│  ② Session ID = Ledger Session ID（1:1 对应）                   │
│  ③ 刷新/重启后 Session 从 Ledger 重建，消息不会丢失             │
│  ④ 压缩 = 新追加到压缩流水账，不修改原始记录                   │
│  ⑤ API 层必须使用 getMessagesAsync() 从 Ledger 读取            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 数据流

```
用户请求 ─────────────────────────────────────────────────────────────────
    │
    ▼
┌─────────────────┐
│  LedgerWriter   │ ─── append to context-ledger.jsonl
│  (token count)  │      更新内存中的累计 token 计数
└─────────────────┘
    │
    ▼
┌─────────────────┐
│  LedgerReader   │ ─── buildSessionView(sessionId, maxTokens)
│  (lazy load)    │      读取最新压缩块摘要 + 最新原始消息
└─────────────────┘     计算 token 总数，确保不超过 maxTokens
    │
    ▼
┌─────────────────┐
│     Session     │ ─── 动态构建的消息窗口（可发送给模型）
│   (cached view) │      包含：压缩摘要 + 最新原始消息
└─────────────────┘
    │
    ▼
模型响应 ──────────── 写入 Ledger ─── 更新 Session 指针
```

### 2.2 Session 结构

```typescript
interface Session {
  id: string;
  name: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;

  // Ledger 指针
  ledgerPath: string;           // 指向 ledger 文件路径
  latestCompactIndex: number;   // 最新压缩块在 compact-memory.jsonl 的行号
  originalStartIndex: number;   // 当前原始消息在 context-ledger.jsonl 的起始行号
  originalEndIndex: number;     // 当前���始消息在 context-ledger.jsonl 的结束行号
  totalTokens: number;          // 当前 session 窗口的 token 总数

  // 缓存（内存中，不持久化）
  _cachedView?: SessionView;
}

interface SessionView {
  compressedSummary?: string;   // 压缩摘要（作为 system message）
  messages: SessionMessage[];   // 最新原始消息
  tokenCount: number;
}
```

### 2.3 Ledger 记录格式

**原始层 (context-ledger.jsonl)**:
```jsonl
{"id":"msg-xxx","timestamp_ms":1234567890,"session_id":"session-xxx","agent_id":"agent-xxx","role":"user","content":"...","token_count":50,"event_type":"user_message"}
{"id":"msg-yyy","timestamp_ms":1234567891,"session_id":"session-xxx","agent_id":"agent-xxx","role":"assistant","content":"...","token_count":200,"event_type":"assistant_message"}
```

**压缩层 (compact-memory.jsonl)**:
```jsonl
{"id":"compact-xxx","timestamp_ms":1234567900,"session_id":"session-xxx","summary":"用户讨论了X问题，助手提供了Y方案...","user_preference_patch":"用户偏好：喜欢简洁回复","source_range":{"start":0,"end":50},"token_count":1500}
```

---

## 3. 压缩流程

### 3.1 触发条件
- `session.totalTokens > COMPRESS_TOKEN_THRESHOLD`
- 默认阈值：85% of context window (256K tokens = 262,144，阈值为 222,822 tokens)

### 3.2 压缩流程

```
1. 确定压缩范围：
   - 从 originalStartIndex 到 originalEndIndex 的原始消息
   - 只处理指针范围内的数据，不扫描整个 ledger

2. 发送压缩请求给 LLM：
   - 输入：指针范围内的消息
   - 要求生成两个输出：
     a. 消息摘要（标准压缩）
     b. 用户偏好 patch（提取偏好变化）

3. 写入压缩块到 compact-memory.jsonl：
   {
     "id": "compact-xxx",
     "timestamp_ms": ...,
     "summary": "消息摘要内容",
     "user_preference_patch": "用户偏好变化",
     "source_range": {"start": X, "end": Y},
     "token_count": N
   }

4. 更新 Session 指针：
   - latestCompactIndex = 新行号
   - originalStartIndex = originalEndIndex + 1
   - totalTokens = 重新计算
   - _cachedView = undefined (清空缓存)

5. 用户偏好合并（每日定时任务）：
   - 读取 USER.md 现有内容
   - 读取当天所有 user_preference_patch
   - 调用 LLM 合并生成新 USER.md
```

---

## 4. Token 计算与配置

### 4.1 Token 计算模块
- 路径：`src/utils/token-counter.ts`
- 使用 tiktoken 或等效库估算 token 数
- 接口：`estimateTokens(text: string): number`

### 4.2 配置项

```json
{
  "contextWindow": 262144,           // 256K tokens
  "compressTokenThreshold": 222822,  // 85% of 256K
  "sessionMaxTokens": 262144
}
```

配置权威来源：`~/.finger/config/user-settings.json`，读取入口：`src/core/user-settings.ts`。

---

## 5. USER.md 合并机制

### 5.1 触发时机
- 每日 00:00 定时任务
- 或手动触发

### 5.2 合并流程
1. 读取 USER.md 现有内容
2. 读取 compact-memory.jsonl 中当天产生的所有 `user_preference_patch`
3. 调用 LLM 合并生成新的 USER.md
4. 保留历史记录在 `USER-history.jsonl`

---

## 6. 模块依赖

```
token-counter.ts ─────────────────────────────────────────────────────────
    │
    ▼
ledger-writer.ts ────────┐
    │                    │
    ▼                    │
ledger-reader.ts ◀───────┘
    │
    ▼
session-manager.ts (改造)
    │
    ▼
user-preference-merger.ts
```

---

## 7. 迁移策略

### 7.1 不兼容旧设计
- 旧的 Session.json（含 messages 数组）不自动迁移
- 新旧版本不兼容，需要清理旧数据或手动迁移

### 7.2 首次启动
- 检测到旧格式 Session 文件时记录警告
- 创建新的 Ledger 文件和指针

---

## 8. 性能考虑

### 8.1 懒加载
- Session 视图只在需要时构建
- 缓存有效窗口，避免每次请求都读取 ledger

### 8.2 压缩时机
- 基于累计 token 数判断，避免频繁压缩
- 压缩只处理指针范围，不扫描整个文件

### 8.3 文件大小
- JSONL 格式支持流式读取
- 可考虑定期归档旧的压缩块

---

## 9. 测试计划

### 9.1 单元测试
- Token 计算准确性
- Ledger 写入/读取
- 压缩流程
- 用户偏好合并

### 9.2 集成测试
- 完整流程：消息写入 → token 累加 → 压缩 → 视图重建
- 边界：空 session、大消息量、压缩中写入

---

## 10. 相关文档
- `docs/design/permission-management-design.md` - 权限管理设计
- `docs/design/system-agent-v2-design.md` - System Agent V2 设计
- `MEMORY.md` - 项目记忆
