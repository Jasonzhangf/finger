# Context Builder 动态上下文构建设计

> Last updated: 2026-03-28 23:58 +08:00  
> Status: Active  
> Owner: Jason
>
> 配套架构文档：
> - `docs/design/ledger-only-dynamic-session-views.md`

## 1. 目标

Context Builder 负责动态重建模型可见上下文中的 **history 区**，并显式区分：
- **Working Set / 本轮推理区**
- **Historical Memory Zone / 历史记忆区**

它不改其他固定注入段：
- skills
- mailbox
- 系统/开发者提示词
- AGENTS 路由、HEARTBEAT 等

即：**history-only**。

---

## 1.2 Runtime Context Layout（ASCII）

```text
+----------------------------------------------------------------------------------+
| P0 core_instructions                                                            |
|    - system/developer/global hard rules                                         |
+----------------------------------------------------------------------------------+
| P1 runtime_capabilities                                                         |
|    - skills / mailbox / FLOW / tool contracts                                   |
+----------------------------------------------------------------------------------+
| P2 current_turn                                                                  |
|    - current user input + attachments                                            |
+----------------------------------------------------------------------------------+
| P3 continuity_anchors                                                            |
|    - recent tasks + recent user turns (continuity pins)                         |
+----------------------------------------------------------------------------------+
| P4 dynamic_history   <-- only this zone is rebuilt/reordered/compressed         |
|    +------------------------------------+-------------------------------------+  |
|    | historical_memory                  | working_set                         |  |
|    | - compact task digest preferred    | - current task full chain          |  |
|    | - from compact-memory replacement  | - always kept at tail              |  |
|    +------------------------------------+-------------------------------------+  |
+----------------------------------------------------------------------------------+
| P5 canonical_storage (not directly injected as full text)                       |
|    - context-ledger.jsonl (raw truth)                                           |
|    - compact-memory.jsonl (digest/summary truth)                                |
+----------------------------------------------------------------------------------+
```

---

## 1.3 压缩与重建流程（ASCII）

```text
[Turn execution]
   |
   +--> session.messages (runtime snapshot grows continuously)
   +--> context-ledger.jsonl (append-only raw)
   |
   +--> context usage >= threshold (85%)
          |
          +--> compressContext()
                 |
                 +--> sessionManager.compressContext()    (pointer advance)
                 +--> build replacement_history digests   (task-level compact)
                 +--> context_ledger.memory(action=compact, replacement_history=...)
                        -> compact-memory.jsonl

[Later context rebuild / bootstrap/on-demand]
   |
   +--> buildContext(session snapshot)
          |
          +--> if compact replacement_history exists:
                  historical_memory := compact digests
                  working_set := latest live task
              else:
                  historical_memory := raw task blocks
                  working_set := latest live task
```

---

## 1.4 Ranking Provider 不可用时的降级策略（新增）

当 `enableModelRanking=active` 且排序模型不可用（例如 `provider_not_found/http_xxx/exception/parse_failed`）时：

1. 不中断本轮；
2. 将 `historical_memory` 转为 task digest blocks（请求 + 结果 + 关键工具）；
3. `working_set` 保持当前任务完整链路；
4. metadata 记录 `rankingReason=digest_fallback:<reason>`，便于进度与排障可见。

> 该策略确保 context builder 专用大模型不可用时，系统仍可继续推理而不丢关键上下文。

---

## 1.1 不可破坏约束（硬规则）

### 最小历史单位 = 一个完整 task

Context Builder 只能在 **task block** 级别做选择/排序/预算截断，不能在 task 内做裁剪。

一个 task 的边界定义为：
- 从一条用户请求（`role=user`）开始
- 包含该轮中间的全部执行轨迹（assistant/tool_call/tool_result/tool_error/reasoning 等）
- 直到该轮完成（`finish_reason=stop`，或进入下一条用户请求前的完整链路）

### 禁止 task 内编辑

对已选中的 task block：
- 不允许删除 task 内部消息
- 不允许改写 task 内部顺序
- 不允许只保留 task 的“摘要片段”替代原始链路

可做的仅有：
- 选择哪些 task block 进入 history
- 调整 task block 之间顺序（按 mode/ranking）
- 在超预算时整块丢弃某些 task block（绝不拆块）

> 备注：附件可使用占位摘要（`attachments: {count, summary}`）以控制输入体积，但不改变 task 内事件链路语义。

---

## 2. 三种模式（mode）

配置字段：`contextBuilder.mode`

### 2.1 minimal（最轻模式）
- 仅移除无关 task
- 不从历史补充 task
- 当前 task（Working Set）始终保留在尾部，不参与历史竞争

示意：
- 原始: `[task1] [task2(无关)] [task3] [task4(当前)]`
- 结果: `[task1] [task3] [task4(当前)]`

### 2.2 moderate（中等模式）
- 先移除无关 task（按 task 最小颗粒）
- 再从历史按相关性补充 task
- **关键规则**：
  - 如果单个补充 task 超过“移除量”，但总 tokens 仍在上下文预算内，仍允许补充
- 当前 task（Working Set）始终保留在尾部

流程：
1. 识别并移除无关 task，记录 `removedTokens`
2. 对历史候选按相关性排序
3. 逐个补充：
   - 优先在“移除额度”内补充
   - 若超出移除额度但仍不超总预算，也允许补充
4. 直到预算耗尽或无候选

### 2.3 aggressive（激进模式）
- 完全按相关性重排历史 task
- 当前 task（Working Set）固定尾部
- 最大化相关性

示意：
- 原始: `[task1] [task2] [task3] [task4(当前)]`
- 相关性排序: `task3 > task1 > task2`
- 结果: `[task3] [task1] [task2] [task4(当前)]`

---

## 3. 排序（ranking）与 dryrun

字段：`contextBuilder.enableModelRanking`
- `false`: 不调用排序模型
- `true` (active): 调排序模型并应用重排
- `'dryrun'`: 调排序模型但**不改顺序**，只输出可观测结果

`rankingProviderId` 关联 `user-settings.json.aiProviders`，不硬编码模型。

---

## 3.1 上下文显式分区

### Working Set（本轮推理区）
- 当前 task block
- 当前用户输入及其直接相关的本轮消息
- 不参与历史 recall 竞争
- 必须稳定保留在上下文尾部

### Historical Memory Zone（历史记忆区）
- 所有非当前 task 的历史候选
- 可经过 embedding recall / model ranking / budget truncation
- 是预算受限区

### 观测要求
构建结果 metadata 必须暴露：
- `workingSetTaskBlockCount`
- `historicalTaskBlockCount`
- `workingSetMessageCount`
- `historicalMessageCount`
- `workingSetTokens`
- `historicalTokens`

每条 context message 也应标记所属分区：
- `contextZone = working_set | historical_memory`

---

## 4. 关键配置

文件：`~/.finger/config/user-settings.json`

```json
{
  "contextBuilder": {
    "enabled": true,
    "mode": "minimal | moderate | aggressive",
    "historyBudgetTokens": 20000,
    "budgetRatio": 0.85,
    "halfLifeMs": 86400000,
    "overThresholdRelevance": 0.5,
    "enableModelRanking": false,
    "rankingProviderId": "tcm",
    "includeMemoryMd": false
  }
}
```

说明：
- 历史重建预算以 `historyBudgetTokens` 为准，按 task 粒度累计，不按消息条数截断。
- 预算控制必须在 task block 边界生效，不允许对 task 内消息做 budget slice。
- 默认历史预算为 **20k**；coding/debugging 场景推荐通过 `context_builder.rebuild` 先尝试 **50k**，只有 50k 仍不足时再尝试 **110k**。
- 复杂任务的默认策略：先用 `context_ledger.memory` 做 `search` → `query(detail=true)` 证据检索，再决定是否触发 `context_builder.rebuild`；禁止无证据的惯性重建。
- `budgetRatio` 仅作兼容回退；当 `historyBudgetTokens` 存在时优先使用固定 token 预算。
- `MEMORY.md` 不直接注入模型上下文；长期记忆需保持精简，只记录可验证的 ground truth。

---

## 5. UI 与 API

### 5.1 UI（Settings）
在左侧 `Settings` 新增 Context Builder 控件：
- 启用/禁用
- `mode` 选择：minimal / moderate / aggressive
- `historyBudgetTokens`（历史 token 预算，默认 20k）
- `ranking` 选择：off / dryrun / active

### 5.2 API
- `GET /api/v1/context-builder/settings`
- `PUT /api/v1/context-builder/settings`

---

## 6. Context Monitor 可观测性

Context Monitor 会显示：
- `history-only`
- `mode`
- `ranking` 状态（含 dryrun）
- `removed/supplemented` 计数（metadata）

并固定交互语义：
1. 选 Round（最小单元）
2. 看该 Round 的 Selected Context 组合
3. 右侧对照原始 Ledger（已选/未选）
4. 点击查看详情

---

## 7. 实现落点

- `src/runtime/context-builder.ts`：三模式核心逻辑、moderate 补充规则、当前 task 尾部约束
- `src/core/user-settings.ts`：`contextBuilder.mode` + `enableModelRanking`(含 dryrun)
- `src/server/routes/system.ts`：Context Builder settings API
- `src/orchestration/session-manager.ts`：将 `mode` 传入 `buildContext`
- `src/server/routes/ledger-routes.ts`：Context Monitor 返回 mode/ranking 元数据
- `ui/src/components/LeftSidebar/LeftSidebar.tsx`：Settings 选择器

---

## 8. Indexed Continuity（2026-03-28）

为避免“首轮重建后，后续又退回 raw session 顺序”的断裂，新增 `contextBuilderHistoryIndex` 持久化索引（session context 字段）：

- 首次 bootstrap / on-demand rebuild 后，落盘：
  - `historySelectedMessageIds`
  - `currentContextMessageIds`
  - `pinnedMessageIds`（可选）
  - `anchorMessageId` / `anchorTimestamp`
- 后续轮次优先走 `context_builder_indexed`：
  - 合并顺序：`pinned + 历史选中 + 上轮 current + 本轮 delta(anchor 之后)`
  - 受 `currentContextMaxItems` 约束滚动更新 current 区
- 仅当索引缺失或索引产物为空时，才退回 bootstrap / raw fallback。

同时，模型侧历史组装新增保护：
- 当 `contextHistorySource` 为 `context_builder_*` 时，不再让 `metadata.kernelApiHistory` 覆盖 builder 产物。
