# Context Builder 设计（收敛版）

> Last updated: 2026-04-15
> Status: Active / Simplified

## 1. 当前定位

`context_builder.rebuild` 现在不是一套独立的 context builder pipeline。

它的唯一职责是：
- 作为**显式 topic rebuild 工具入口**
- 调用 `src/runtime/context-history/*`
- 把 rebuild 结果回写到 `Session.messages`

换句话说：
**tool 是入口，不是实现。**

---

## 2. 唯一执行链

```text
model/tool call
  -> context_builder.rebuild
  -> forceRebuild(sessionId, ledgerPath, 'topic', ...)
  -> runtime/context-history/rebuild.ts
  -> __rebuiltMessages
  -> runtime-facade
  -> sessionManager.replaceMessages()
  -> 下一轮直接消费 Session.messages
```

---

## 3. 与自动 overflow 的关系

显式 tool rebuild 与自动 overflow rebuild 的差别只在 **mode**：
- `overflow`：超限自动触发
- `topic`：显式召回触发

二者共享：
- 同一决策/执行框架
- 同一 Session snapshot 覆盖点
- 同一 digest 数据模型

---

## 4. 当前运行时约束

1. 不再由 `buildContext()` 决定 runtime history
2. 不再维护 bootstrap / indexed / on-demand 三套拼装结果
3. `finger-role-modules` 只读取 `Session.messages`
4. tool 返回的历史必须通过 `replaceMessages()` 成为下一轮唯一可见历史

---

## 5. 结果形态

### topic rebuild
- 输出：相关 digest 历史
- zone：`historical_memory`
- 排序：先 relevance 选，再按时间升序落回 session

### overflow rebuild
- 输出：历史 digest + 最近原文 working set
- zone：`historical_memory` + `working_set`

---

## 6. 禁止事项

以下不再允许作为 context builder 主流程：
- tool 内自己 buildContext
- runtime-facade 内自己 compact/rebuild
- provider 报错后仅返回 `contextRebuildTriggered=true` 但不真正改写 session
- 读取 raw session 之外的另一份“运行时历史视图”
