# Ledger-Session 一体化架构设计

> Last updated: 2026-03-21 19:06:00 +08:00
> Status: Design Approved

## 1. 核心原则

### 1.1 Ledger = 唯一数据真源
- 所有消息/事件只写入 Ledger JSONL 文件（append-only）
- Ledger 包含两个文件：
  - `context-ledger.jsonl`：原始消息层，无限延展
  - `compact-memory.jsonl`：压缩记忆层，无限延展
- 两个文件都是只追加不修改

### 1.2 Session = 动态视图
- Session 从 Ledger 构建，缓存当前有效窗口
- 懒加载 + 缓存机制：只在压缩或超阈值时重建
- Session 文件只存元数据 + 指针，不存 messages 数组

### 1.3 压缩范围
- 压缩只取 ledger 指针范围内的数据，不处理整个 ledger
- 压缩生成两个输出：
  1. **消息摘要**：标准的内容压缩
  2. **用户偏好 patch**：提取用户偏好变化

---

## 2. 架构设计

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

### 3.1 触��条件
- `session.totalTokens > COMPRESS_TOKEN_THRESHOLD`
- 默认阈值：85% of context window (256K tokens ≈ 217,600 tokens)

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

配置存储在 `~/.finger/config/config.json`，可通过系统设置动态调整。

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
