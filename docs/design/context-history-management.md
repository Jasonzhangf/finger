# Context History Management 设计文档

## 1. 概述

上下文历史管理分为两种完全不同的流程：
1. **重建上下文**：换话题或空上下文时，需要搜索历史 digest 并组建新的 history
2. **压缩**：上下文超限时，压缩当前上下文并合并到历史

## 2. 核心概念

### 2.1 上下文结构

```
history = context.history (历史 digest) + current.history (当前完整消息)
```

- `context.history`：已压缩的 digest，来自 compact-memory.jsonl
- `current.history`：最近 N 轮完整消息，未压缩

### 2.2 预算约束

| 区域 | 预算 | 说明 |
|------|------|------|
| context.history | 20K tokens | 刚性约束，滑动窗口 |
| current.history | 最近 3 轮完整 | 不压缩，保持原始格式 |

### 2.2.1 "一轮" 的精确定义

1 轮 = 1 次 user 消息 + 对应的 assistant 回复（含中间 tool_calls）。
即从 user 发言到 assistant 最终回复之间的所有消息算 1 轮。
如果 1 轮中包含巨大的 tool_output，该轮仍完整保留（不截断），
但计入 current.history 的 token 总量。

### 2.2.2 token 二次校验

`estimateTokens` 是粗估（每 4 字符 ~1 token），存在误差。
**必须在组装最终 payload 前进行二次校验**：
如果实际 token 超过预算，从 context.history 最早的 digest 开始丢弃，
直到满足预算。

### 2.3 触发条件

| 场景 | 触发条件 | 流程类型 |
|------|----------|---------|
| 换话题 | 多轮 topic_shift 置信度超过阈值 | 重建上下文 |
| 空上下文 | 新 session / heartbeat session | 重建上下文 |
| 超限 | context.history + current.history 超过预算 | 压缩 |

### 2.3.1 换话题检测机制

不是单次 LLM 判断就触发，而是通过**多轮命中**来确认：
- 每次 LLM 返回 topic_shift 置信度
- 连续 N 次（默认 2 次）置信度超过阈值（默认 0.7）
- 才触发重建上下文
- 这样可以避免误判（用户说"继续"不会触发）

### 2.3.2 任务隔离机制

通过换话题检测来实现任务隔离：
- 不同任务 = 不同话题
- 换话题触发重建 → 搜索时自然按新话题相关性过滤
- 旧任务的 digest 因为与新话题相关性低，不会被选中
- 不需要显式的 task_id 过滤

## 3. 流程详解

### 3.1 重建上下文（换话题/空）

步骤：

1. **前置检查**
   - 检查索引是否 ready（mtime < 3秒）
   - 如果未 ready → 返回 waiting_for_index
   - 检查是否有并发 rebuild → 互斥锁等待

2. **Tokenize 用户请求（直接分词，无需 LLM）**
   - 分词生成搜索 query
   - 无需 LLM 改写或扩展

3. **搜索历史 digest**
   - 调用 mempalace
   - 搜索 compact-memory.jsonl
   - topK = 20（多取一些，后面再筛选）
   - 设置硬超时 2s，超时返回空结果

4. **相关性过滤 + 排序**
   - 丢弃相关性 < 30% 的结果
   - 剩余按相关性从高到低排序
   - 如果过滤后为空 → 返回空 context.history

5. **预算框选**
   - 按相关性从高到低累加 token
   - 总 token ≤ 20K 时停止
   - 得到候选 digest 集合

6. **按时间顺序重排序**
   - 将候选 digest 按时间戳排序
   - 从早到晚排列
   - 保证历史连贯性

7. **组建 context.history**
   - 输出最终的 history digest 列表
   - 每个 digest 含：summary, tags, timestamp
   - 不清空 current.history（重建只改 context.history）

**关键点**：
- 需要搜索！依赖 embedding 索引
- 先按相关性筛选（> 30%），再按时间排序
- 保证历史连贯性（时间顺序）
- 不清空 current.history
- token 二次校验

### 3.2 压缩（超限）

步骤：

1. **前置检查**
   - 检查是否有并发 compact/rebuild → 互斥锁等待

2. **写入 pending marker（崩溃恢复用）**
   - 写入 .compact-pending.json
   - 包含 compaction_id, session_id, started_at

3. **压缩当前上下文**
   - 按 "子任务" 分组遍历 current.history
   - 每个子任务生成独立 digest：
     - 请求摘要
     - 结果摘要
     - 工具列表
     - tags（自动提取：文件名、工具名、关键词）
   - 标记 compactDigest: true
   - 不对已有的 digest 再压缩（只压缩原始消息）

4. **合并历史 digest**
   - 读取现有 context.history
   - 将新 digest 追加到末尾
   - 保持时间顺序

5. **20K Token 滑动窗口**
   - 从最新的 digest 开始倒序累加
   - 总 token ≤ 20K 时停止
   - 超出部分丢弃（旧的 digest）
   - 丢弃的 digest 仍在 compact-memory.jsonl 中，重建时可搜索回来

6. **清空当前上下文**
   - current.history = []
   - 最近 3 轮已转为 digest 合并到 context.history

7. **写入 compact-memory.jsonl**
   - 保存新 digest
   - 删除 pending marker（标记完成）
   - token 二次校验

**关键点**：
- 不需要搜索！直接压缩
- 滑动窗口保证 20K token 预算
- 清空 current.history
- 只压缩原始消息，不压缩已有的 digest
- 每个子任务独立生成 digest（不是只取 first/last）
- 自动提取 tags

### 3.3 混合场景（换话题 + 超限）

步骤：

1. **先执行压缩（不依赖索引）**
   - 压缩 current.history → digest
   - 合并到 context.history
   - 清空 current.history

2. **再执行重建（依赖索引）**
   - 搜索历史 digest
   - 替换 context.history
   - current.history 保持为空（刚清空）

**关键点**：
- 先压缩（不依赖索引，一定能成功）
- 再重建（依赖索引，可能需要等待）
- 两步都需要互斥锁

### 3.4 崩溃恢复流程

启动时：

1. **检查 .compact-pending.json 是否存在**
   - 不存在 → 正常启动
   - 存在 → 进入恢复流程

2. **检查 compact-memory.jsonl 最后一条**
   - 如果 compaction_id 匹配 → 压缩已完成，删除 pending marker
   - 如果不匹配 → 重新执行压缩（幂等，结果一致）

## 4. 模块拆分设计

### 4.1 目录结构

```
src/runtime/context-history/
├── types.ts              # 共享类型定义
├── utils.ts              # 共享工具函数
├── rebuild.ts            # 重建上下文（换话题/空）
├── compact.ts            # 压缩（超限）
├── decision.ts           # 触发判断
├── executor.ts           # 执行入口
├── lock.ts               # session 级互斥锁
├── recovery.ts           # 崩溃恢复
└── index.ts              # 导出
```

### 4.2 模块职责

| 模块 | 职责 | 依赖 |
|------|------|------|
| types.ts | 类型定义 | 无 |
| utils.ts | token估算、预算控制、时间排序 | types.ts |
| rebuild.ts | 前置检查→分词→搜索→相关性过滤→预算框选→时间排序→组建 | utils.ts, mempalace |
| compact.ts | 前置检查→pending marker→子任务分组压缩→合并→滑动窗口→写入 | utils.ts |
| decision.ts | 触发条件判断（多轮 topic_shift 累计） | types.ts |
| executor.ts | 路由到 rebuild/compact/混合流程 | decision.ts, rebuild.ts, compact.ts |
| lock.ts | session 级互斥锁 | 无 |
| recovery.ts | 崩溃恢复 | compact.ts |

### 4.3 接口定义

详见文档完整版（types.ts、utils.ts、rebuild.ts、compact.ts、decision.ts、executor.ts、lock.ts、recovery.ts 接口）

## 5. 数据流

### 5.1 重建上下文数据流

```
用户请求 → Tokenize → Query tokens
→ Mempalace Search → TaskDigest[] (按相关性)
→ Filter (relevance > 30%) → TaskDigest[]
→ Budget Select → TaskDigest[] (≤ 20K tokens)
→ Sort By Time → TaskDigest[] (时间顺序)
→ context.history = TaskDigest[]
（current.history 不变）
```

### 5.2 压缩数据流

```
current.history (SessionMessage[])
→ Group By Round → ConversationRound[]
→ Compress Each Round → TaskDigest[]
→ Merge → existingHistory + TaskDigest[]
→ Sliding Window → TaskDigest[] (≤ 20K tokens)
→ context.history = TaskDigest[]
→ current.history = []
```

### 5.3 混合场景数据流

```
current.history (超限) + 换话题
→ Compact → digest → 合并到 context.history → 清空 current
→ Rebuild → 搜索 → 替换 context.history
→ context.history = 搜索结果
→ current.history = []
```

## 6. 关键约束

### 6.1 重建上下文约束

1. **索引依赖**：必须等 mempalace 索引完成才能执行
2. **相关性优先**：先按相关性筛选（> 30%），再按时间排序
3. **预算刚性**：总 token ≤ 20K
4. **时间连贯**：最终输出按时间顺序排列
5. **不清空 current**：重建只改 context.history

### 6.2 压缩约束

1. **无索引依赖**：直接压缩，无需搜索
2. **保留最近**：最近 3 轮完整保留（转为 digest 合并到 context.history）
3. **预算刚性**：context.history ≤ 20K tokens
4. **滑动窗口**：从最新开始倒序保留
5. **只压缩原始消息**：不对已有 digest 再压缩
6. **子任务独立 digest**：不合并多个子任务

## 7. 错误处理

### 7.0 并发控制

| 场景 | 处理 |
|------|------|
| 同 session 并发 rebuild | SessionLock 互斥，第二个排队等待 |
| 同 session 并发 compact | SessionLock 互斥，第二个排队等待 |
| rebuild + compact 同时触发 | 先 compact 再 rebuild（混合流程） |

### 7.1 重建上下文错误

| 错误 | 处理 |
|------|------|
| 索引未完成 | 返回 waiting_for_index，通知用户等待 |
| 搜索无结果 | 返回空 history，保留 current.history |
| 超时 (>2s) | 返回空结果 + 警告日志，保留 current.history |
| 搜索服务不可用 | 返回空结果 + 错误日志，保留 current.history |

### 7.2 压缩错误

| 错误 | 处理 |
|------|------|
| 压缩失败 | 保留原始 current.history，返回错误 |
| compact-memory 写入失败 | 重试 1 次，失败则返回错误，保留 pending marker |
| 崩溃恢复 | 启动时检查 pending marker，重新执行或标记完成 |

### 7.3 混合场景错误

| 错误 | 处理 |
|------|------|
| 压缩成功但重建失败（索引未完成） | 保持压缩结果，通知用户等待索引 |
| 压缩失败 | 不执行重建，返回错误 |

## 8. 性能指标

| 指标 | 目标 |
|------|------|
| 重建上下文延迟 | < 500ms |
| 压缩延迟 | < 100ms |
| 索引等待时间 | < 3s |
| 搜索超时 | 2s 硬超时 |

## 9. 已确认决策

| 问题 | 决策 |
|------|------|
| Tokenize 方案 | 直接分词，无需 LLM |
| 相关性阈值 | 30%（低于此值的搜索结果丢弃） |
| 心跳 session | 不排除系统提示词 |
| 任务隔离 | 通过换话题的多轮命中来切换，不使用显式 task_id |

## 10. 测试矩阵

| # | 场景 | rebuild | compact | 预期结果 |
|---|------|---------|---------|---------|
| T1 | �� session | ✅ 空 | ❌ | context.history = [], current.history 正常 |
| T2 | 正常对话 | ❌ | ❌ | 保持原始，不做任何操作 |
| T3 | 换话题（多轮命中） | ✅ 搜索 | ❌ | 重建 context.history |
| T4 | 超限 | ❌ | ✅ 压缩 | 压缩 current → digest，清空 current |
| T5 | 换话题 + 超限 | ✅ 搜索 | ✅ 先压缩 | 先压缩再重建 |
| T6 | 索引未完成 + 超限 | ❌ | ✅ 压缩 | 先压缩，通知用户等待索引 |
| T7 | 搜索无结果 | ✅ 空 | ❌ | context.history = [], 保留 current |
| T8 | 崩溃恢复 | ❌ | ✅ 恢复 | 检查 pending marker，重执行 |
| T9 | 并发 rebuild | ❌ | ❌ | 互斥锁，第二个排队 |
| T10 | 搜索超时 | ❌ | ❌ | 返回空 + 警告，保留 current |
| T11 | 多轮压缩累积 | ❌ | ✅ 多次 | 只压缩原始消息，不对 digest 再压缩 |
| T12 | 单轮 topic_shift | ❌ | ❌ | 不触发（需多轮命中） |
| T13 | compact-memory 写入失败 | ❌ | ✅ 重试 | 重试 1 次，失败保留原始 |
| T14 | token 估算偏差 | ❌ | ✅ | 二次校验，丢弃最早 digest |

## 11. 后续步骤

1. ~~Review 本设计文档~~ ✅ 已完成
2. ~~确认待确认事项~~ ✅ 已确认
3. 拆分代码到独立模块
4. 编写单元测试（覆盖测试矩阵 T1-T14）
5. 集成到 runtime-facade.ts
6. 删除旧代码（context-rebuild-executor.ts 相关逻辑）
