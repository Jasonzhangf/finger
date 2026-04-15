# Session Classification + Context Builder（Tag-Aggregated）设计

## 背景

当前 system agent 的上下文构建缺少 tag 感知能力，context builder 的排序完全依赖大模型对内容文本的分析。

同时，现有 session 使用缺少"同类任务累计"策略，导致 session 碎片化和历史复用不足。

## 目标

以 **task 粒度**（`用户请求 + finish_reason=stop`）实现：

1. task 结束自动 summary + 动态多 tag（不限数量）
2. 不拆分 session，保持单一 session（或少量 session）
3. context builder 从 ledger 提取 tags，在排序时将 tag 匹配作为最高优先级信号
4. 大模型排序时同时考虑：tag 匹配 > 内容相关性 > 时间接近度

## 设计决策

### 为什么不拆分 session？

原始设计考虑 session switch（不同 topic 切到不同 session），但用户认为：
- 既然 tag 已持久化到 ledger，直接按 tag 聚合即可
- 不需要复杂的 session 切换逻辑
- ledger 是唯一真源，tag 信息已经在里面
- context builder 已有大模型排序能力，只需增强 tag 感知

### 为什么不限制 tag 数量？

- tag 由大模型在 task completion 时自动生成
- 限制数量可能导致重要分类信息丢失
- 排序模型可以自行判断哪些 tag 更相关

## 已完成

### 1) context builder 调用 session id 修正 ✅
- `KernelAgentBase` 使用外部/响应 session id 调用 `contextHistoryProvider`
- 修复了 `Context builder session not found, fallback` 问题

### 2) Task-end tagging pipeline ✅
- `DispatchSummaryResult` 新增 `tags[]` + `topic` 字段
- `sanitizeDispatchResult` 从 `raw.tags` / `response.tags` / `topic` 提取并去重
- ledger metadata 持久化 tags + topic
- mailbox envelope 包含 tags 用于可观测性
- tag 字符串长度不限（仅过滤空值和纯空白）

### 3) Context builder tag-aware 增强 ✅
- `TaskBlock` 新增 `tags?: string[]` + `topic?: string` 字段
- `finalizeBlock` 从 assistant 消息的 metadata 中提取 tags/topic
- 模型排序 prompt 从"双重维度"升级为"三重维度"：
  - 一、标签匹配（最高优先级）
  - 二、内容相关性（次要维度）
  - 三、时间相关性（最后维度）
- block preview 包含 tags/topic 信息供排序模型参考

### 4) Embedding hybrid recall ✅
- context builder 在模型排序前新增 session-local embedding recall 层
- 基于 task block 的 `tags + topic + 首条 user + 最后一条 assistant` 构建 embedding 文本
- embedding index 持久化到 session ledger 目录下的 `task-embedding-index.json`
- 当前 prompt 先对历史 task 做语义召回，再交给后续 build mode / 模型排序处理
- 无 tag task 也能依赖 summary/content 语义命中，不再只靠 tag 精确匹配
- 当前 task 不参与历史重排，始终保留在尾部

## 数据流

```
用户请求 → system agent → task completion (finish_reason=stop)
  → dispatch result 中 tags/topic 字段
  → 写入 ledger metadata
  → 下次 context builder 读取 ledger
  → groupByTaskBoundary 提取 tags 到 TaskBlock
  → 大模型排序时将 tag 匹配作为最高优先级信号
  → 组装 tag-aware 的上下文历史
```

## 验收标准

1. dispatch 结果包含 tags 时，ledger metadata 中可见
2. context builder 构建时，TaskBlock 包含从 ledger 提取的 tags
3. 排序 prompt 包含 tag 匹配维度
4. 同 topic 的历史 task 在排序中获得更高优先级
5. tag 数量不受限，但空值被过滤

## 相关文件

- `src/common/agent-dispatch.ts` — tags 提取和标准化
- `src/runtime/context-history/rebuild.ts` — 现行 topic / overflow rebuild 入口
- `src/runtime/context-ledger-memory.ts` — recall / ledger 查询与召回能力
- `src/runtime/context-builder-embedding-recall.ts` — session-local task embedding index + semantic recall
- `src/runtime/context-builder-types.ts` — TaskBlock tags/topic 类型
- `src/server/modules/agent-runtime/dispatch.ts` — ledger metadata 持久化
- `src/server/modules/mailbox-envelope.ts` — envelope tags
- `src/server/modules/event-forwarding.ts` / `event-forwarding-helpers.ts` — tag 提取辅助函数
