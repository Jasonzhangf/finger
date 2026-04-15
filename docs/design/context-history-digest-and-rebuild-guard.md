# Context History Digest + Rebuild Guard（唯一真源版）

> Last updated: 2026-04-15
> Status: Active / Guardrails

## 1. 强约束

1. **唯一出发点**：运行时历史只从 `Session.messages` 读取
2. **唯一实现点**：`src/runtime/context-history/*`
3. **唯一覆盖点**：`sessionManager.replaceMessages()`
4. **唯一两种模式**：`overflow` / `topic`
5. **禁止双实现**：任何模块不得再维护并行的 compact/rebuild/history builder 逻辑
6. **禁止运行时 fallback 历史源**：`_cachedView` / indexed / on-demand / mempalace rebuild 都不得再充当 prompt 历史来源

---

## 2. digest 模型约束

digest 是历史压缩后的可见表示，不是第二份运行时实现。

必须满足：
- digest 消息带 `compactDigest=true`
- 历史 digest 带 `contextZone='historical_memory'`
- 最近原文 working set 带 `contextZone='working_set'`
- digest 可以来自 ledger compact history 或 session 旧消息提炼

---

## 3. 触发矩阵

| 场景 | 是否允许 rebuild | 模式 |
|---|---:|---|
| 正常对话未超限 | 否 | - |
| 正常对话超限 | 是 | `overflow` |
| 模型显式调用 `context_history.rebuild` | 是 | `topic` |
| provider overflow / route overflow retry | 是 | `overflow` |

说明：
- “超限只报错”是错误行为
- “换话题时走另一套 builder”是错误设计

---

## 4. overflow 唯一行为

```text
old session messages
  -> build digests
  -> historical_memory
recent raw tail (20K)
  -> working_set
final
  -> replace Session.messages
```

要求：
- 自动触发后必须真的改写 session snapshot
- 改写后同轮/下一轮消费的都是新 snapshot

---

## 5. topic 唯一行为

```text
digest corpus
  -> keyword/entity recall
  -> relevance sort
  -> budget cut (20K)
  -> time ascending
  -> replace Session.messages
```

要求：
- 最终进入 session 的是召回后的相关 digest
- 不允许再由 indexed/bootstrap/on-demand 路径二次改写

---

## 6. 接入守卫

以下模块只能“接入”，不能“重新实现”历史重建：
- `kernel-agent-base.ts`
- `runtime-facade.ts`
- `message-route-execution.ts`
- `context_history.rebuild tool`
- `finger-role-modules.impl.ts`

它们允许做的事情只有：
- 判断是否要调用 rebuild
- 传入参数
- 接收结果
- 覆盖 `Session.messages`

---

## 7. 排障检查单

若再次出现“上下文超限但没压缩”，优先检查：
1. 是否命中了 `forceRebuild(..., 'overflow')`
2. `replaceMessages()` 是否成功
3. rebuild 后是否重新生成 runtime metadata / prompt
4. provider retry 是否消费了新 session snapshot
