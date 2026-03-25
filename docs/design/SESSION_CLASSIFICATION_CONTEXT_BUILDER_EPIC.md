# Session Classification + Context Builder（Task 粒度）设计

## 背景

当前 system agent 在多数请求中未有效执行 context builder 的历史重建，日志显示频繁 fallback：

- `Context builder session not found, fallback to session history`

同时，现有 session 使用缺少“同类任务累计”策略，导致 session 碎片化和历史复用不足。

## 目标

以 **task 粒度**（`用户请求 + finish_reason=stop`）实现：

1. task 结束自动 summary + 动态多 tag
2. 新请求进入时判断是否继续上一 task（保守策略）
3. 明确换 topic 时执行 session switch（tag 置信度 + 时间接近）
4. 无匹配时创建新 session
5. 进入 session 后由 context builder 做时间顺序的 context history 细分组装

## 已完成（本轮）

### 1) context builder 调用 session id 修正

在 `KernelAgentBase` 中，`contextHistoryProvider` 过去使用内部 memory session id（`session.id`）调用，
而 `finger-role-modules` 的 provider 使用 runtime/session-manager 查询外部 session id，导致 miss。

已修复为使用外部/响应 session id：

- `contextHistorySessionId = responseSessionId || input.sessionId || session.id`
- `contextHistoryProvider(contextHistorySessionId, ...)`

效果：provider 能收到外部 session id，后续可命中 runtime session 并进入 buildContext。

### 2) 回归测试

新增断言：provider 收到外部 session id

- `tests/unit/agents/kernel-agent-base.test.ts`
  - 断言 `providerSessionIds === ['ui-session-context-meta-1']`

## 待实现（Epic 范围）

### A. Task 结束自动打 tag

在 `finish_reason=stop` 的 task completion 路径，增强 summary 结构：

```json
{
  "summary": "...",
  "tags": ["finger", "backend", "bugfix"]
}
```

并将 tags 持久化到 ledger 的 task block metadata。

### B. Session 级粗筛 + 切换

新请求进入后由 context builder 执行 session 选择前置：

1. 判断“是否上一任务延续”
   - 不确定 => 保守继续当前 session
2. 明确换 topic => 在候选 sessions 做打分：
   - 多 tag 命中置信度（主维度）
   - 时间接近度（次维度）
3. 选择最高分 session，或新建 session

### C. Session 内细分组装

进入目标 session 后，沿用 context builder 的 task block 排序与预算裁剪，
按时间顺序输出 context history。

## 默认策略

- 保守续接：不能确定换 topic 时继续当前 session
- tag 允许多值（动态）
- 匹配排序：`tag 置信度 > 时间接近度`
- 无匹配：新建 session

## 验收标准

1. 普通追问场景：稳定复用当前 session（不误切）
2. 明确换题场景：自动切到最匹配 session
3. 新题场景：自动新建 session
4. context builder 日志不再持续出现 `session not found` fallback
5. prompt injection snapshot 中可见 context builder 重建元数据（history source / rebuilt 标记）
