# Context Rebuild 设计文档（唯一实现版）

> Last updated: 2026-04-15
> Status: Active / Canonical
> 唯一实现目录：`src/runtime/context-history/*`

## 1. 目标

上下文历史只允许存在 **一套 rebuild 实现**。

它同时覆盖两类场景：
1. **正常对话超限**：自动 overflow rebuild
2. **换话题 / 模型显式请求**：topic rebuild

不再维护独立的 compact / bootstrap / indexed / on-demand 多套历史拼装语义。

---

## 2. 唯一真源

### 2.1 代码真源
- 决策：`src/runtime/context-history/decision.ts`
- 执行入口：`src/runtime/context-history/executor.ts`
- 两种 rebuild：`src/runtime/context-history/rebuild.ts`
- 类型与预算：`src/runtime/context-history/types.ts`
- digest / budget 工具：`src/runtime/context-history/utils.ts`

### 2.2 运行时数据真源
- **唯一可消费历史快照**：`Session.messages`
- **唯一切换点**：`sessionManager.replaceMessages(sessionId, rebuiltMessages)`
- **持久化原始事实**：ledger（append-only）

### 2.3 唯一显式工具入口
- `context_builder.rebuild`
- 工具本身不再实现 rebuild，只调用 `forceRebuild(..., 'topic')`

---

## 3. 唯一 rebuild 语义

## 3.1 overflow 模式（自动）

触发条件：当前会话历史预计超过上下文预算。

唯一行为：
1. 从 `current.history` / `Session.messages` 中抽取旧消息生成 digest
2. digest 写成 `historical_memory`
3. 最近原文消息按 **20K raw window** 保留为 `working_set`
4. 最终写回：`historical digests + recent raw working_set`

结果要求：
- digest 消息：`metadata.compactDigest = true`
- digest 区：`metadata.contextZone = 'historical_memory'`
- working set：`metadata.contextZone = 'working_set'`
- 顺序：历史 digest 在前，最近原文在后

## 3.2 topic 模式（显式）

触发条件：模型显式调用 `context_builder.rebuild`，或系统明确强制 topic rebuild。

唯一行为：
1. 从 digest 中抽关键词 / 实体
2. 做 recall
3. 按匹配度排序
4. 按 **20K budget** 截断
5. 最终按**时间升序**写回 `historical_memory`

结果要求：
- 只写回相关 digest 历史
- 不在 topic rebuild 中混入无关原文 working set
- 输出仍通过 `sessionManager.replaceMessages()` 覆盖 session snapshot

---

## 4. 全局接入路径

## 4.1 自动 overflow
- `src/agents/base/kernel-agent-base.ts`
  - 模型调用前做 preflight
  - 若超限，调用 `forceRebuild(..., 'overflow')`
  - rebuild 成功后重新生成 context slots / runtime metadata / system prompt

- `src/server/routes/message-route-execution.ts`
  - provider / route 返回 overflow 错误时
  - 使用同一 `forceRebuild(..., 'overflow')`
  - `replaceMessages()` 后 retry

## 4.2 显式 topic rebuild
- `src/tools/internal/context-builder-rebuild-tool.ts`
  - 固定走 `forceRebuild(..., 'topic')`
  - 返回 `__rebuiltMessages`

- `src/runtime/runtime-facade.ts`
  - 仅负责把 tool 结果里的 `__rebuiltMessages`
    应用到 `sessionManager.replaceMessages()`
  - 不再自行决策 / 自行 compact / 自行 rebuild

## 4.3 runtime 历史消费
- `src/serverx/modules/finger-role-modules.impl.ts`
  - 只消费当前 `Session.messages`
  - 不再额外 bootstrap / indexed / on-demand 组装历史

---

## 5. 明确废弃的旧路径

以下逻辑不再是 canonical flow：
- TS 侧独立 compact 流程
- runtime-facade 内部重复 rebuild 决策
- finger-role-modules 的 bootstrap / indexed / on-demand 历史拼装链
- “超限仅报错不自动 rebuild”的行为
- “先 compact，再走另一套 rebuild” 的双语义路径

原则：
**所有历史重建最终都必须收敛到 `src/runtime/context-history/*`。**

---

## 6. 设计硬约束

1. **唯一出发点**：`Session.messages`
2. **唯一自动流程**：overflow -> digest old history -> keep 20K raw tail -> replace snapshot
3. **唯一实现点**：`src/runtime/context-history/*`
4. ledger 是原始事实，不直接充当运行时拼装逻辑的第二实现
5. rebuild 只改变动态 history，不改 system / skills / mailbox / FLOW 注入层

---

## 7. 验收标准

- 超限时不再只报错，必须自动触发 overflow rebuild
- `context_builder.rebuild` 与自动 overflow 共享同一 core
- runtime 最终只消费 `Session.messages`
- 文档、工具、route、runtime-facade 都指向同一实现
